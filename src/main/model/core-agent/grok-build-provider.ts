/** LLMProvider backed by xAI's official Grok Build CLI login.
 * Commander turns run in the host-selected project directory with the full
 * Orkas orchestration prompt. Background/direct inference remains text-only.
 * Authentication and subscription quota stay owned by the official CLI. */

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
import {
  bindAbort,
  killProcessTree,
  spawnCli,
  type LocalCliPermissionDecision,
  type LocalCliPermissionRequest,
} from '../../features/local_agents/backends/base';
import { grokBackend } from '../../features/local_agents/backends/grok';

const DISALLOWED_TOOLS = [
  'run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep',
  'kill_command_or_subagent', 'todo_write', 'get_command_or_subagent_output',
  'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor',
  'search_tool', 'use_tool', 'workflow', 'ask_user_question', 'image_gen',
  'image_edit', 'image_to_video', 'reference_to_video', 'write',
].join(',');

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const PRIVATE_RUNTIME_CONTEXT_NOTICE =
  'Private runtime context for task continuation only. Never quote, summarize, acknowledge, or mention this block, its labels, or its bookkeeping in user-visible output.';

export interface GrokBuildSystemPromptParts {
  identityAndRules: string;
  userIntentRules: string;
  projectInstructions?: string;
  memory?: string;
  languageDirective?: string;
}

/** Host-provided orkas-bridge handle for one Commander ACP turn. `server` is
 *  the raw MCP entry ACP carries in `session/new`; `close` tears the host
 *  socket down after the turn. */
export interface GrokCommanderBridge {
  mcpConfigPath: string;
  server: { command: string; args: string[]; env: Record<string, string> };
  appendSystemPrompt?: string;
  close: () => Promise<void>;
}

/** Lazy bridge factory. Returning null means the host declined the bridge and
 *  the Commander keeps its native tools without orchestration dispatch. */
export type GrokCommanderBridgeFactory = (
  signal: AbortSignal,
) => Promise<GrokCommanderBridge | null>;

export interface GrokBuildProviderOptions {
  commander?: boolean;
  workingDir?: string;
  /** Host approval bridge. Commander turns use the same renderer approval
   * dialog and IPC path as local Agents; without it Grok CLI permission
   * requests are denied rather than silently allowed. */
  requestPermission?: (request: LocalCliPermissionRequest) => Promise<LocalCliPermissionDecision>;
  /** Clear host-side run-scoped approvals when the provider turn ends. */
  onCommanderTurnEnd?: () => void;
  /** Commander ACP bridge exposing `commander.dispatch`: Grok delegates to a
   * real OrkaS Agent through the host instead of simulating it in prose. */
  commanderBridge?: GrokCommanderBridgeFactory;
}

/** Hard zombie cap for one Commander CLI process. The authoritative stall
 * detection remains the core-agent turn watchdog; this only prevents a
 * detached child from living forever. */
const COMMANDER_ACP_TIMEOUT_MS = 60 * 60 * 1000;

/** Explicit allowlist for the text-only model. The full Commander prompt is
 * never parsed or subtracted from. */
export function composeGrokBuildSystemPrompt(parts: GrokBuildSystemPromptParts): string {
  return [
    parts.identityAndRules,
    parts.userIntentRules,
    parts.projectInstructions,
    parts.memory,
    parts.languageDirective,
  ].map(block => block?.trim()).filter(Boolean).join('\n\n');
}

function markPrivateRuntimeContext(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return `${trimmed}\n${PRIVATE_RUNTIME_CONTEXT_NOTICE}`;
  return [
    trimmed.slice(0, firstBreak),
    PRIVATE_RUNTIME_CONTEXT_NOTICE,
    trimmed.slice(firstBreak + 1),
  ].join('\n');
}

function contentText(content: MessageContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'tool_result') return `[Tool result]\n${content.content}`;
  if (content.type === 'tool_use') return `[Tool request: ${content.name}]\n${JSON.stringify(content.input)}`;
  if (content.type === 'image') return '[Image omitted: Grok Build ordinary chat is currently text-only.]';
  return '';
}

/** Candidate-local projection for Grok Build. The input objects are never
 * mutated. Completed history has already been bounded by the shared Session
 * projection; this adapter changes only capability-specific instructions. */
export function projectGrokBuildCompletionParams(
  params: CompletionParams,
  systemPrompt: string,
  turnContext?: { full: string; textOnly: string },
): CompletionParams {
  let currentUserIndex = -1;
  for (let i = params.messages.length - 1; i >= 0; i--) {
    if (params.messages[i].role === 'user') {
      currentUserIndex = i;
      break;
    }
  }
  if (currentUserIndex < 0) return { ...params, systemPrompt };

  const messages = params.messages.slice();
  if (turnContext?.full.trim()) {
    const current = messages[currentUserIndex];
    const full = markPrivateRuntimeContext(turnContext.full);
    const textOnly = markPrivateRuntimeContext(turnContext.textOnly);
    const projected = current.content.flatMap(content => {
      if (content.type !== 'text' || content.text !== full) return [content];
      return textOnly ? [{ ...content, text: textOnly }] : [];
    });
    if (projected.length !== current.content.length
      || projected.some((content, index) => content !== current.content[index])) {
      messages[currentUserIndex] = { ...current, content: projected };
    }
  }
  return {
    ...params,
    systemPrompt,
    messages,
  };
}

export function formatGrokBuildPrompt(
  params: CompletionParams,
  options: GrokBuildProviderOptions = {},
): string {
  const bridgeDispatch = !!(options.commander && options.commanderBridge);
  const sections: string[] = options.commander
    ? [
        'You are the Commander serving an Orkas multi-agent conversation.',
        // The ACP session exposes Grok's own native tools (file read / edit /
        // shell). Only when the host attaches the orkas bridge does the
        // `commander.dispatch` MCP tool exist; otherwise those host tools
        // (dispatch_to, hand_off_to, run_worker, connector meta-tools,
        // @skill/@agent reads) cannot be projected over ACP. Without this
        // override the model hunts for absent tools, finds an empty MCP list,
        // and never uses its native file tools.
        'Use your own native tools to read, search, edit files and run commands in the current working directory; do the local work yourself instead of looking for OrkaS host tools.',
        bridgeDispatch
          ? 'An MCP server named "orkas" is attached and exposes orkas_dispatch_to_agent. Call it to delegate one real named agent (pass its name/agent_id and the execution contract); the OrkaS host runs that agent and returns the settled worker result as the tool result. Never simulate a dispatch in prose, and never do the delegated agent\'s work yourself as a substitute.'
          : 'The OrkaS orchestration tools (dispatch_to, hand_off_to, run_worker), connector meta-tools, MCP discovery, and @skill/@agent spec reads mentioned in the system instructions are NOT available in this session. Do not attempt to call them. If a task genuinely requires another OrkaS agent, say so explicitly in your reply instead of simulating a dispatch.',
      ]
    : [
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

function usableCommanderWorkingDir(raw: string | undefined): string | undefined {
  if (!raw || !path.isAbsolute(raw)) return undefined;
  try {
    const resolved = path.resolve(raw);
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch { return undefined; }
}

export function buildGrokBuildCliInvocation(
  params: CompletionParams,
  promptFile: string,
  requestDir: string,
  _options: GrokBuildProviderOptions = {},
): { args: string[]; cwd: string } {
  return {
    cwd: requestDir,
    args: [
      '--prompt-file', promptFile,
      '--model', params.model,
      '--output-format', 'streaming-json',
      '--no-subagents',
      '--disable-web-search',
      '--disallowed-tools', DISALLOWED_TOOLS,
      '--permission-mode', 'plan',
      '--max-turns', '1',
      '--verbatim',
    ],
  };
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
  const cacheReadTokens = Number(
    raw?.cache_read_input_tokens || raw?.cacheReadInputTokens || raw?.cachedReadTokens || 0,
  ) || 0;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    totalTokens: Number(raw?.total_tokens || raw?.totalTokens || inputTokens + outputTokens) || inputTokens + outputTokens,
  };
}

export type GrokBuildLoginState = 'authenticated' | 'unauthenticated' | 'probe_failed' | 'unavailable';

export interface GrokBuildLoginStatus {
  state: GrokBuildLoginState;
  authenticated: boolean;
  reason?: 'login_required' | 'unexpected_response' | 'timeout' | 'process_error' | 'cli_unavailable';
}

export function classifyGrokBuildModelsProbe(
  exitCode: number | null,
  output: string,
  timedOut = false,
): GrokBuildLoginStatus {
  if (timedOut) return { state: 'probe_failed', authenticated: false, reason: 'timeout' };
  const text = String(output || '');
  if (/not authenticated|not logged in|login required|please\s+(?:run\s+)?grok\s+login/i.test(text)) {
    return { state: 'unauthenticated', authenticated: false, reason: 'login_required' };
  }
  const hasAuthenticatedMarker = /logged in with\s+grok\.com/i.test(text);
  const hasUsableModelList = /available models\s*:/i.test(text)
    && /grok-(?:4(?:\.[0-9]+)?|[a-z0-9][a-z0-9._-]*)/i.test(text);
  if (exitCode === 0 && (hasAuthenticatedMarker || hasUsableModelList)) {
    return { state: 'authenticated', authenticated: true };
  }
  return {
    state: 'probe_failed',
    authenticated: false,
    reason: exitCode === null ? 'process_error' : 'unexpected_response',
  };
}

async function runModelsProbe(): Promise<GrokBuildLoginStatus> {
  const binPath = await resolvedGrokPath();
  const child = spawnCli(binPath, ['models'], grokWorkspace());
  child.stdin.end();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-64 * 1024); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-64 * 1024); });
  const result = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut });
    };
    const timer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
      finish(null, true);
    }, 15_000);
    child.once('error', () => finish(null, false));
    child.once('close', (code) => finish(code, false));
  });
  return classifyGrokBuildModelsProbe(result.exitCode, output, result.timedOut);
}

export async function inspectGrokBuildLogin(): Promise<GrokBuildLoginStatus> {
  try {
    const first = await runModelsProbe();
    if (first.state !== 'probe_failed') return first;
    // A short retry absorbs transient file locks and CLI start races without
    // turning an indeterminate probe into a false "login required" verdict.
    await new Promise(resolve => setTimeout(resolve, 120));
    return await runModelsProbe();
  } catch {
    return { state: 'unavailable', authenticated: false, reason: 'cli_unavailable' };
  }
}

export async function validateGrokBuildLogin(): Promise<boolean> {
  const status = await inspectGrokBuildLogin();
  // Only an explicit unauthenticated response is proof that login is absent.
  // A transient probe failure must not block a valid CLI session; the actual
  // request will still surface a concrete CLI error if authentication fails.
  return status.state === 'authenticated' || status.state === 'probe_failed';
}

/** Starts the official Grok browser authorization command. Orkas never reads
 * or writes the CLI-owned credential file. */
export async function spawnGrokBuildLogin() {
  const binPath = await resolvedGrokPath();
  return spawnCli(binPath, ['login', '--oauth'], grokWorkspace());
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

async function *streamGrok(
  params: CompletionParams,
  options: GrokBuildProviderOptions = {},
): AsyncIterable<StreamEvent> {
  const binPath = await resolvedGrokPath();
  const workspace = grokWorkspace();
  const requestDir = fs.mkdtempSync(path.join(workspace, 'request-'));
  const promptFile = path.join(requestDir, 'prompt.txt');
  fs.writeFileSync(promptFile, formatGrokBuildPrompt(params, options), { encoding: 'utf8', mode: 0o600 });
  let invocation: { args: string[]; cwd: string };
  try {
    invocation = buildGrokBuildCliInvocation(params, promptFile, requestDir, options);
  } catch (err) {
    try { fs.rmSync(requestDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
  const child = spawnCli(binPath, invocation.args, invocation.cwd);
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

/** Forward the host abort signal into the ACP backend's own controller. */
function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  if (signal.aborted) { controller.abort(); return () => {}; }
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Commander transport: the official ACP server (`grok agent stdio`).
 *
 * The headless `streaming-json` mode cannot surface permission requests, so a
 * Commander that needs to edit files or run commands could only be run with
 * every tool pre-approved or disabled. ACP is Grok's supported interactive
 * protocol: it carries `session/request_permission`, lets the turn continue
 * after a denial, and reports turn usage. We reuse Orkas' existing ACP backend
 * so the renderer approval dialog / IPC path stays the single approval UI.
 */
async function *streamGrokCommanderAcp(
  params: CompletionParams,
  options: GrokBuildProviderOptions,
): AsyncIterable<StreamEvent> {
  const cwd = usableCommanderWorkingDir(options.workingDir);
  if (!cwd) {
    throw new Error('Grok Build Commander requires an existing project workspace directory.');
  }
  const binPath = await resolvedGrokPath();
  const prompt = formatGrokBuildPrompt(params, options);
  const controller = new AbortController();
  const detachAbort = forwardAbort(params.signal, controller);

  // Attach the host orkas-bridge so the CLI can run a REAL OrkaS Agent
  // (`orkas_dispatch_to_agent`) instead of narrating a dispatch. A failed
  // bridge degrades to native-tools-only; it never fails the Commander turn.
  let bridge: GrokCommanderBridge | null = null;
  if (options.commanderBridge) {
    try {
      bridge = await options.commanderBridge(controller.signal);
    } catch { bridge = null; }
  }

  const events: StreamEvent[] = [{ type: 'message_start' }];
  let wake: (() => void) | null = null;
  let finished = false;
  let status = 'completed';
  let failure: Error | null = null;
  let fullText = '';
  let usage: Usage = { ...EMPTY_USAGE };
  const notify = () => { const fn = wake; wake = null; fn?.(); };
  const push = (event: StreamEvent) => { events.push(event); notify(); };

  // ACP carries tool execution this process does not own: the CLI runs the
  // call and reports the lifecycle. Track open rows so a result always
  // addresses the same call id, and so a turn that dies mid-tool does not
  // leave a permanently "running" row behind.
  const openTools = new Map<string, { name: string; output?: string }>();
  let thinkingOpen = false;
  const startThinking = () => {
    if (thinkingOpen) return;
    thinkingOpen = true;
    push({ type: 'thinking_start' });
  };
  const endThinking = () => {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    push({ type: 'thinking_end' });
  };
  const closeOpenTools = (isError: boolean) => {
    if (!openTools.size) return;
    for (const [id, tool] of openTools) {
      push({
        type: 'tool_result',
        id,
        name: tool.name,
        ...(tool.output ? { output: tool.output } : {}),
        ...(isError ? { isError: true } : {}),
      });
    }
    openTools.clear();
  };

  const running = grokBackend.run({
    binPath,
    cwd,
    prompt,
    signal: controller.signal,
    timeoutMs: COMMANDER_ACP_TIMEOUT_MS,
    modelOverride: params.model,
    requestPermission: options.requestPermission,
    ...(bridge ? {
      bridge: {
        mcpConfigPath: bridge.mcpConfigPath,
        server: bridge.server,
        ...(bridge.appendSystemPrompt ? { appendSystemPrompt: bridge.appendSystemPrompt } : {}),
      },
    } : {}),
    onEvent: (event) => {
      if (event.type === 'thinking') {
        // ACP thought chunks are the CLI's real reasoning text. They are
        // forwarded as reasoning activity only; nothing is synthesized when
        // the CLI emits no thought stream.
        const text = typeof event.text === 'string' ? event.text : '';
        if (!text) return;
        startThinking();
        push({ type: 'thinking_delta', chars: text.length, text });
        return;
      }
      if (event.type === 'tool-event') {
        endThinking();
        const id = typeof event.callId === 'string' ? event.callId.trim() : '';
        if (!id) return;
        const name = typeof event.tool === 'string' && event.tool.trim() ? event.tool.trim() : 'tool';
        const toolStatus = typeof event.status === 'string' ? event.status.trim().toLowerCase() : '';
        if (event.phase === 'use') {
          if (openTools.has(id)) return;
          openTools.set(id, { name });
          push({
            type: 'tool_call',
            id,
            name,
            ...(event.input !== undefined ? { input: event.input } : {}),
          });
          return;
        }
        if (event.phase !== 'result') return;
        const opened = openTools.get(id);
        // ACP `tool_call_update` without a status is an in-place update, not a
        // completion: Grok sends the human title/description that way before
        // the terminal `completed` update that carries the real output. Closing
        // on it produced a duplicate row with ~0ms and the description as the
        // result.
        if (!toolStatus) {
          if (opened) {
            if (typeof event.output === 'string' && event.output) opened.output = event.output;
            return;
          }
          // A server that reports no start at all still needs a visible row.
          openTools.set(id, { name, ...(typeof event.output === 'string' && event.output ? { output: event.output } : {}) });
          push({ type: 'tool_call', id, name, ...(event.input !== undefined ? { input: event.input } : {}) });
          return;
        }
        if (toolStatus !== 'completed' && toolStatus !== 'failed' && toolStatus !== 'cancelled') return;
        const failed = event.isError === true || toolStatus === 'failed' || toolStatus === 'cancelled';
        // ACP terminal updates commonly omit the title, so the row keeps the
        // name that opened the call instead of degrading to a generic label.
        if (!opened) {
          openTools.set(id, { name });
          push({ type: 'tool_call', id, name });
        }
        openTools.delete(id);
        push({
          type: 'tool_result',
          id,
          name: opened?.name || name,
          output: typeof event.output === 'string' && event.output
            ? event.output
            : opened?.output || '',
          ...(failed ? { isError: true } : {}),
        });
        return;
      }
      if (event.type === 'text-delta' && typeof event.text === 'string' && event.text) {
        endThinking();
        fullText += event.text;
        push({ type: 'text_delta', text: event.text });
        return;
      }
      if (event.type !== 'done') return;
      endThinking();
      const doneStatus = String(event.status || 'completed');
      closeOpenTools(doneStatus !== 'completed');
      if (event.usage) usage = usageFrom(event.usage);
      // Some ACP servers only expose the final answer on the terminal event
      // instead of streaming agent_message_chunk deltas.
      if (!fullText.trim() && typeof event.output === 'string' && event.output.trim()) {
        fullText = event.output;
      }
      if (doneStatus !== 'completed') {
        status = doneStatus;
        const detail = typeof event.error === 'string' ? event.error.trim() : '';
        const stderrTail = typeof event.stderrTail === 'string' ? event.stderrTail.trim() : '';
        // Surface the CLI's own diagnostics: an ACP failure otherwise collapses
        // into a bare status word and the reason is not recoverable from the UI.
        const hint = !detail && stderrTail ? ` — ${stderrTail.slice(-300)}` : '';
        failure = new Error(detail || `Grok Build Commander ${doneStatus}${hint}`);
      }
      finished = true;
      notify();
    },
  }).then(
    () => { finished = true; notify(); },
    (err) => {
      if (!failure) failure = err instanceof Error ? err : new Error(String(err));
      status = 'failed';
      finished = true;
      notify();
    },
  );

  try {
    while (!finished || events.length) {
      if (events.length) { yield events.shift()!; continue; }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (failure) throw failure;
    if (status !== 'completed') throw new Error(`Grok Build Commander ${status}`);
    if (!fullText.trim()) throw new Error('Grok Build returned an empty response');
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage,
      content: [{ type: 'text', text: fullText }],
      model: params.model,
    };
  } finally {
    detachAbort();
    controller.abort();
    try { await running; } catch { /* already surfaced via the done event */ }
    try { await bridge?.close(); } catch { /* bridge teardown never masks the turn */ }
    options.onCommanderTurnEnd?.();
  }
}

export function createGrokBuildProvider(
  modelId: string,
  options: GrokBuildProviderOptions = {},
): LLMProvider {
  const stream = (params: CompletionParams) => (
    options.commander ? streamGrokCommanderAcp(params, options) : streamGrok(params, options)
  );
  return {
    id: 'grok-build',
    name: 'Grok Build',
    contextBudgetModel: () => modelId,
    validateAuth: validateGrokBuildLogin,
    stream,
    async complete(params: CompletionParams): Promise<CompletionResult> {
      let text = '';
      let usage: Usage = { ...EMPTY_USAGE };
      for await (const event of stream(params)) {
        if (event.type === 'text_delta') text += event.text;
        if (event.type === 'message_end' && event.usage) usage = { ...usage, ...event.usage };
      }
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: params.model };
    },
  };
}
