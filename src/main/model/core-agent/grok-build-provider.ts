/**
 * Text-only LLMProvider backed by xAI's official Grok Build CLI login.
 *
 * This is intentionally separate from the local coding-Agent integration:
 * ordinary Orkas chat receives a single model turn, no filesystem/tool access,
 * and no API key. Authentication and subscription quota remain owned by the
 * official `grok` client.
 */

import type {
  CompletionParams,
  CompletionResult,
  LLMProvider,
  MessageContent,
  StreamEvent,
  Usage,
} from '#core-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCliForDispatch } from '../../features/local_agents/registry';
import { bindAbort, spawnCli } from '../../features/local_agents/backends/base';

const DISALLOWED_TOOLS = [
  'run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep',
  'kill_command_or_subagent', 'todo_write', 'get_command_or_subagent_output',
  'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor',
  'search_tool', 'use_tool', 'workflow', 'ask_user_question', 'image_gen',
  'image_edit', 'image_to_video', 'reference_to_video', 'write',
].join(',');

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function contentText(content: MessageContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'tool_result') return `[Tool result]\n${content.content}`;
  if (content.type === 'tool_use') return `[Tool request: ${content.name}]\n${JSON.stringify(content.input)}`;
  if (content.type === 'image') return '[Image omitted: Grok Build ordinary chat is currently text-only.]';
  return '';
}

export function formatGrokBuildPrompt(params: CompletionParams): string {
  const sections: string[] = [
    'You are the text model serving an Orkas conversation.',
    'Do not use tools, edit files, start subagents, or ask for terminal access. Return only the assistant response.',
  ];
  if (params.systemPrompt?.trim()) sections.push(`[SYSTEM]\n${params.systemPrompt.trim()}`);
  for (const message of params.messages) {
    const text = message.content.map(contentText).filter(Boolean).join('\n').trim();
    if (text) sections.push(`[${message.role.toUpperCase()}]\n${text}`);
  }
  sections.push('[ASSISTANT]');
  return sections.join('\n\n');
}

function grokWorkspace(): string {
  const dir = path.join(os.tmpdir(), 'orkas-grok-chat');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function resolvedGrokPath(): Promise<string> {
  const entry = await resolveCliForDispatch('grok');
  if (!entry.available || !entry.path) throw new Error(entry.errorDetail || 'Grok Build CLI is unavailable');
  return entry.path;
}

function usageFrom(raw: any): Usage {
  const inputTokens = Number(raw?.input_tokens || raw?.inputTokens || 0) || 0;
  const outputTokens = Number(raw?.output_tokens || raw?.outputTokens || 0) || 0;
  const cacheReadTokens = Number(raw?.cache_read_input_tokens || raw?.cacheReadInputTokens || 0) || 0;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    totalTokens: Number(raw?.total_tokens || raw?.totalTokens || inputTokens + outputTokens) || inputTokens + outputTokens,
  };
}

async function runModelsProbe(): Promise<{ ok: boolean; output: string }> {
  const binPath = await resolvedGrokPath();
  const child = spawnCli(binPath, ['models'], grokWorkspace());
  child.stdin.end();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-64 * 1024); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-64 * 1024); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { ok: exitCode === 0 && /logged in with grok\.com/i.test(output), output };
}

export async function validateGrokBuildLogin(): Promise<boolean> {
  try { return (await runModelsProbe()).ok; }
  catch { return false; }
}

export function buildGrokBuildModel(modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'grok-build' as any,
    baseUrl: 'local://grok-build',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  };
}

async function *streamGrok(params: CompletionParams): AsyncIterable<StreamEvent> {
  const binPath = await resolvedGrokPath();
  const workspace = grokWorkspace();
  const requestDir = fs.mkdtempSync(path.join(workspace, 'request-'));
  const promptFile = path.join(requestDir, 'prompt.txt');
  fs.writeFileSync(promptFile, formatGrokBuildPrompt(params), { encoding: 'utf8', mode: 0o600 });
  const child = spawnCli(binPath, [
    '--prompt-file', promptFile,
    '--model', params.model,
    '--output-format', 'streaming-json',
    '--no-subagents',
    '--disable-web-search',
    '--disallowed-tools', DISALLOWED_TOOLS,
    '--permission-mode', 'plan',
    '--max-turns', '1',
    '--verbatim',
  ], requestDir);
  child.stdin.end();
  const detachAbort = params.signal ? bindAbort(child, params.signal) : () => {};
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const events: StreamEvent[] = [{ type: 'message_start' }];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  let buffer = '';
  let stderr = '';
  let fullText = '';
  let usage: Usage = { ...EMPTY_USAGE };
  const notify = () => { const fn = wake; wake = null; fn?.(); };
  const push = (event: StreamEvent) => { events.push(event); notify(); };

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const event = JSON.parse(line);
          if (event?.type === 'text' && typeof event.data === 'string') {
            fullText += event.data;
            push({ type: 'text_delta', text: event.data });
          } else if (event?.type === 'usage') {
            usage = usageFrom(event.usage);
          } else if (event?.type === 'end') {
            usage = usageFrom(event.usage || usage);
          } else if (event?.type === 'error') {
            failure = new Error(String(event.error || event.message || 'Grok Build request failed'));
          }
        } catch { /* ignore non-protocol stdout */ }
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16 * 1024); });
  child.once('error', (err) => { failure = err; done = true; notify(); });
  child.once('close', (code) => {
    if (code !== 0 && !failure) failure = new Error(stderr.trim() || `Grok Build exited with code ${code}`);
    done = true;
    notify();
  });

  try {
    while (!done || events.length) {
      if (events.length) { yield events.shift()!; continue; }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (failure) throw failure;
    if (!fullText.trim()) throw new Error(stderr.trim() || 'Grok Build returned an empty response');
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage,
      content: [{ type: 'text', text: fullText }],
      model: params.model,
    };
  } finally {
    detachAbort();
    try { fs.rmSync(requestDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function createGrokBuildProvider(modelId: string): LLMProvider {
  return {
    id: 'grok-build',
    name: 'Grok Build',
    contextBudgetModel: () => modelId,
    validateAuth: validateGrokBuildLogin,
    stream: streamGrok,
    async complete(params: CompletionParams): Promise<CompletionResult> {
      let text = '';
      let usage: Usage = { ...EMPTY_USAGE };
      for await (const event of streamGrok(params)) {
        if (event.type === 'text_delta') text += event.text;
        if (event.type === 'message_end' && event.usage) usage = { ...usage, ...event.usage };
      }
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: params.model };
    },
  };
}
