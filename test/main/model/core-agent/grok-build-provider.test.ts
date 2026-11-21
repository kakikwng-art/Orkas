import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompletionParams } from '#core-agent';
import { prompts } from '../../../../src/main/prompts/loader';
import {
  classifyGrokBuildModelsProbe,
  buildGrokBuildCliInvocation,
  composeGrokBuildSystemPrompt,
  createGrokBuildProvider,
  formatGrokBuildPrompt,
  projectGrokBuildCompletionParams,
} from '../../../../src/main/model/core-agent/grok-build-provider';

describe('grok-build-provider', () => {
  it('keeps the text-only headless invocation for non-Commander turns', () => {
    const invocation = buildGrokBuildCliInvocation(
      { model: 'grok-4.7', messages: [] },
      path.join(os.tmpdir(), 'prompt.txt'),
      path.join(os.tmpdir(), 'request-fallback'),
    );
    expect(invocation.cwd).toBe(path.join(os.tmpdir(), 'request-fallback'));
    expect(invocation.args).toContain('--output-format');
    expect(invocation.args).toContain('streaming-json');
    expect(invocation.args).toContain('--disallowed-tools');
    expect(invocation.args).toContain('plan');
    expect(invocation.args[invocation.args.indexOf('--max-turns') + 1]).toBe('1');
    // Commander capabilities must not leak into the text-only path.
    expect(invocation.args).not.toContain('--tools');
  });

  it('runs the Commander turn in the selected project with orchestration context', () => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-grok-project-'));
    try {
      const prompt = formatGrokBuildPrompt({
        model: 'grok-4.7-build-fast',
        systemPrompt: 'Commander dispatch protocol: emit Orkas handoffs.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect this project.' }] }],
      }, { commander: true, workingDir });
      expect(prompt).toContain('Commander serving an Orkas multi-agent conversation');
      expect(prompt).toContain('Commander dispatch protocol');
      expect(prompt).not.toContain('Do not use tools, edit files');
      // The ACP session has no OrkaS host tools: the prompt must say so and
      // point Grok at its native file tools instead of the dispatch protocol.
      expect(prompt).toContain('native tools');
      expect(prompt).toContain('NOT available in this session');
      expect(prompt).not.toContain('Follow the Orkas dispatch and handoff protocol');
    } finally {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('advertises the real host dispatch tool when the Commander bridge is attached', () => {
    const prompt = formatGrokBuildPrompt({
      model: 'grok-4.7-build-fast',
      systemPrompt: 'Commander dispatch protocol: emit Orkas handoffs.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Delegate this.' }] }],
    }, {
      commander: true,
      workingDir: os.tmpdir(),
      commanderBridge: async () => null,
    });
    expect(prompt).toContain('Commander serving an Orkas multi-agent conversation');
    // The host bridge is the only real delegation path for an ACP Commander:
    // the prompt must name its tool and forbid a prose-only simulation.
    expect(prompt).toContain('orkas_dispatch_to_agent');
    expect(prompt).toContain('Never simulate a dispatch');
    expect(prompt).toContain('native tools');
    expect(prompt).not.toContain('NOT available in this session');
  });

  it('refuses to downgrade a Commander turn when the workspace directory is missing', async () => {
    // Regression: the per-conversation workspace subdir is created lazily, so
    // a fresh Commander turn used to fail the existence check and silently run
    // the text-only invocation (`--max-turns 1`, tools disabled) in a temp
    // directory. That surfaced as "Error: max turns reached" instead of the
    // real working-directory problem.
    const missing = path.join(os.tmpdir(), `orkas-grok-missing-${process.pid}-${Date.now()}`);
    expect(fs.existsSync(missing)).toBe(false);
    const provider = createGrokBuildProvider('grok-4.7-build-fast', {
      commander: true,
      workingDir: missing,
    });
    await expect((async () => {
      for await (const _event of provider.stream({ model: 'grok-4.7-build-fast', messages: [] })) {
        // The workspace check must reject before any CLI work starts.
      }
    })()).rejects.toThrow(/existing project workspace directory/);
  });

  it('classifies successful model probes without depending on one exact sentence', () => {
    expect(classifyGrokBuildModelsProbe(0, [
      'Default model: grok-4.7',
      'Available models:',
      '  * grok-4.7',
      '  - grok-4.7-build-fast',
    ].join('\n'))).toMatchObject({ state: 'authenticated', authenticated: true });
    expect(classifyGrokBuildModelsProbe(0, 'You are logged in with grok.com.'))
      .toMatchObject({ state: 'authenticated', authenticated: true });
  });

  it('separates explicit logout from an indeterminate probe failure', () => {
    expect(classifyGrokBuildModelsProbe(1, 'Not authenticated. Run grok login.'))
      .toMatchObject({ state: 'unauthenticated', reason: 'login_required' });
    expect(classifyGrokBuildModelsProbe(1, 'Access denied by operating system policy.'))
      .toMatchObject({ state: 'probe_failed', reason: 'unexpected_response' });
    expect(classifyGrokBuildModelsProbe(null, '', true))
      .toMatchObject({ state: 'probe_failed', reason: 'timeout' });
  });

  it('serializes ordinary chat history and explicitly denies tool use', () => {
    const prompt = formatGrokBuildPrompt({
      model: 'grok-4.7',
      systemPrompt: 'Answer in Chinese.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
    });

    expect(prompt).toContain('Do not use tools');
    expect(prompt).toContain('[SYSTEM]\nAnswer in Chinese.');
    expect(prompt).toContain('[USER]\n你好');
    expect(prompt).toContain('[ASSISTANT]\n你好！');
    expect(prompt).toMatch(/\[USER\]\n继续\n\n\[ASSISTANT\]$/);
  });

  it('uses a slim system prompt without re-clipping shared history or changing the source', () => {
    const currentUser = { role: 'user' as const, content: [{ type: 'text' as const, text: '在吗' }] };
    const params: CompletionParams = {
      model: 'grok-4.7',
      systemPrompt: [
        'Commander identity',
        'Available tools: run_terminal_command, read_file',
        'Available skills: skill-a',
        'Dispatch agents and hand off work.',
      ].join('\n'),
      messages: [
        { role: 'user', content: [{ type: 'text', text: '[History window: earlier turns omitted.]' }] },
        { role: 'user', content: [{ type: 'text', text: 'shared bounded history' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'recent short question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'recent short answer' }] },
        currentUser,
      ],
    };
    const sourceSnapshot = JSON.stringify(params);
    const slim = [
      'Orkas text-only assistant identity.',
      'Follow the current user constraints.',
      'Answer in Chinese.',
    ].join('\n');

    const projected = projectGrokBuildCompletionParams(params, slim);
    const projectedPrompt = formatGrokBuildPrompt(projected);
    expect(projected.systemPrompt).toBe(slim);
    expect(projectedPrompt).not.toContain('run_terminal_command');
    expect(projectedPrompt).not.toContain('Available skills');
    expect(projectedPrompt).not.toContain('Dispatch agents');
    expect(projectedPrompt).toContain('Orkas text-only assistant identity.');
    expect(projectedPrompt).toContain('Answer in Chinese.');
    expect(projectedPrompt).toContain('recent short question');
    expect(projectedPrompt).toContain('recent short answer');
    expect(projectedPrompt).toContain('shared bounded history');
    expect(projected.messages.slice(0, -1)).toEqual(params.messages.slice(0, -1));
    expect(projected.messages.at(-1)).toBe(currentUser);
    expect(projected.messages.at(-1)?.content).toEqual(currentUser.content);
    expect(JSON.stringify(params)).toBe(sourceSnapshot);
  });

  it('composes the system prompt from an allowlist without Commander capability blocks', () => {
    const prompt = composeGrokBuildSystemPrompt({
      identityAndRules: prompts.load('chat_grok_text', {}),
      userIntentRules: prompts.load('chat_user_intent_rules', {}),
      projectInstructions: 'Project constraint: answer in scope.',
      memory: 'Relevant user memory.',
      languageDirective: 'Answer in Chinese.',
    });

    expect(prompt).toContain('text-only Grok model serving an Orkas conversation');
    expect(prompt).toContain('Project constraint');
    expect(prompt).toContain('Relevant user memory');
    expect(prompt).toContain('Answer in Chinese');
    expect(prompt).not.toContain('run_terminal_command');
    expect(prompt).not.toContain('Available skills');
    expect(prompt).not.toContain('handoff');
    expect(prompt).not.toContain('Group-chat mechanics');
    expect(prompt).not.toContain('Routing-first algorithm');
  });

  it('replaces only host orchestration context and preserves useful runtime and real user content', () => {
    const actual = { type: 'text' as const, text: '在吗' };
    const fullRuntime = '[Commander orchestration]\nDispatch ledger\n\n[Current context]\nRelevant attachment note';
    const textOnlyRuntime = '[Current context]\nRelevant attachment note';
    const runtime = {
      type: 'text' as const,
      text: '[Commander orchestration]\nPrivate runtime context for task continuation only. Never quote, summarize, acknowledge, or mention this block, its labels, or its bookkeeping in user-visible output.\nDispatch ledger\n\n[Current context]\nRelevant attachment note',
    };
    const params: CompletionParams = {
      model: 'grok-4.7',
      messages: [{ role: 'user', content: [runtime, actual] }],
    };

    const projected = projectGrokBuildCompletionParams(params, 'slim', {
      full: fullRuntime,
      textOnly: textOnlyRuntime,
    });

    expect(projected.messages[0].content).toHaveLength(2);
    expect(projected.messages[0].content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Relevant attachment note'),
    });
    expect(projected.messages[0].content[0]).not.toMatchObject({
      text: expect.stringContaining('Dispatch ledger'),
    });
    expect(params.messages[0].content).toEqual([runtime, actual]);
    expect(projected.messages[0].content[1]).toBe(actual);
  });
});
