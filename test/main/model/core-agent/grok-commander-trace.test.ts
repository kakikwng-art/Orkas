import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import type { CompletionParams, StreamEvent } from '#core-agent';

// Replays the ACP event shape recorded from Grok CLI 1.0.77: every tool call
// arrives as `tool_call` → statusless `tool_call_update` (title/description)
// → `tool_call_update` with `status: "completed"` and the real output.
const state = vi.hoisted(() => ({ script: [] as Array<Record<string, unknown>>, runs: 0 }));

vi.mock('../../../../src/main/features/local_agents/registry', () => ({
  resolveCliForDispatch: vi.fn(async () => ({ available: true, path: 'grok' })),
}));

vi.mock('../../../../src/main/features/local_agents/backends/grok', () => ({
  grokBackend: {
    run: async (opts: { onEvent: (event: Record<string, unknown>) => void }) => {
      state.runs += 1;
      for (const event of state.script) opts.onEvent(event);
    },
  },
}));

import { createGrokBuildProvider } from '../../../../src/main/model/core-agent/grok-build-provider';

const params: CompletionParams = {
  model: 'grok-4.7',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the project' }] }],
};

async function collect(script: Array<Record<string, unknown>>): Promise<StreamEvent[]> {
  state.script = script;
  const provider = createGrokBuildProvider('grok-4.7', {
    commander: true,
    workingDir: os.tmpdir(),
    requestPermission: async () => ({ kind: 'allow' }) as any,
  });
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(params)) events.push(event);
  return events;
}

describe('grok commander tool trace', () => {
  it('closes a call once, on the terminal status, with the readable output', async () => {
    const events = await collect([
      { type: 'thinking', text: 'look at the file first' },
      { type: 'tool-event', tool: 'read_file', callId: 'c1', phase: 'use', input: { target_file: 'a.ts' } },
      { type: 'tool-event', tool: 'tool', callId: 'c1', phase: 'result', output: 'Read a.ts' },
      { type: 'tool-event', tool: 'tool', callId: 'c1', phase: 'result', output: 'file body', status: 'completed' },
      { type: 'text-delta', text: 'done' },
      { type: 'done', status: 'completed' },
    ]);

    const calls = events.filter((event) => event.type === 'tool_call');
    const results = events.filter((event) => event.type === 'tool_result');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'c1', name: 'read_file', input: { target_file: 'a.ts' } });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'c1', name: 'read_file', output: 'file body' });
    expect((results[0] as any).isError).toBeUndefined();
    // The statusless update is progress, not a second row.
    expect(events.filter((event) => event.type === 'tool_call' && event.id === 'c1')).toHaveLength(1);
    expect(events.some((event) => event.type === 'thinking_delta')).toBe(true);
    expect(events.some((event) => event.type === 'message_end')).toBe(true);
  });

  it('keeps the failure state of a failed tool', async () => {
    const events = await collect([
      { type: 'tool-event', tool: 'run_terminal_command', callId: 'c2', phase: 'use', input: { command: 'false' } },
      { type: 'tool-event', tool: 'tool', callId: 'c2', phase: 'result', output: 'boom', status: 'failed' },
      { type: 'text-delta', text: 'could not run it' },
      { type: 'done', status: 'completed' },
    ]);
    const result = events.find((event) => event.type === 'tool_result') as any;
    expect(result).toMatchObject({ id: 'c2', output: 'boom', isError: true });
  });

  it('closes a call that never reports a terminal status when the turn ends', async () => {
    const events = await collect([
      { type: 'tool-event', tool: 'grep', callId: 'c3', phase: 'use', input: { pattern: 'onEvent' } },
      { type: 'tool-event', tool: 'tool', callId: 'c3', phase: 'result', output: 'partial hits' },
      { type: 'text-delta', text: 'summary' },
      { type: 'done', status: 'completed' },
    ]);
    const result = events.find((event) => event.type === 'tool_result') as any;
    expect(result).toMatchObject({ id: 'c3', name: 'grep', output: 'partial hits' });
    expect(result.isError).toBeUndefined();
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
  });
});
