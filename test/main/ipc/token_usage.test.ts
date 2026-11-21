import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-token-ipc-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(async () => {
  try { (await import('../../../src/main/features/token_usage')).closeTokenUsageDatabases(); } catch {}
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Token dashboard IPC', () => {
  it('returns filtered analytics and paged detail totals for the active user', async () => {
    const usage = await import('../../../src/main/features/token_usage');
    const now = Date.now();
    usage.saveTokenUsage('ipc-user', {
      eventId: 'grok-ipc', startedAt: now - 1_000, finishedAt: now,
      provider: 'grok-build', model: 'grok-4.7-build-fast', source: 'core',
      callType: 'provider', status: 'completed', agentId: 'agent-a', projectId: 'project-a',
      usage: { inputTokens: 24_015, outputTokens: 303, cacheReadTokens: 2_048, totalTokens: 26_366 },
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/token_usage');
    const dashboard = await invokeHandlers['tokenUsage.dashboard']({
      allTime: true, provider: 'grok-build', agentId: 'agent-a', projectId: 'project-a',
      timezoneOffsetMinutes: 480,
    }, { userId: 'ipc-user' });
    expect((dashboard.dashboard as any).summary).toMatchObject({
      total_calls: 1, total_tokens: 26_366, cache_read_tokens: 2_048,
    });

    const details = await invokeHandlers['tokenUsage.list']({ provider: 'grok-build', limit: 50 }, { userId: 'ipc-user' });
    expect(details.total).toBe(1);
    expect(details.items[0]).toMatchObject({ provider: 'grok-build', total_tokens: 26_366 });
  });
});
