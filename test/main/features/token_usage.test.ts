import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-token-usage-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const usage = await import('../../../src/main/features/token_usage');
    usage.closeTokenUsageDatabases();
  } catch { /* module may not have loaded */ }
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('token usage ledger', () => {
  it('normalizes Codex CLI field names without adding cache tokens to total', async () => {
    const { normalizeTokenUsage } = await import('../../../src/main/features/token_usage');
    expect(normalizeTokenUsage({ input: 10, output: 4, cacheRead: 7, cacheCreate: 3 })).toEqual({
      usageStatus: 'known',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      reasoningTokens: null,
      totalTokens: 14,
    });
    expect(normalizeTokenUsage({ input: 10, cacheRead: 7 })).toMatchObject({
      usageStatus: 'known', totalTokens: null,
    });
  });

  it('keeps missing usage unknown and unsupported fields NULL', async () => {
    const usage = await import('../../../src/main/features/token_usage');
    usage.saveTokenUsage('u1', {
      eventId: 'unknown-1', startedAt: 1, finishedAt: 2,
      provider: 'p', model: 'm', source: 'core', callType: 'provider', status: 'failed',
    });
    const [row] = usage.listTokenUsage('u1');
    expect(row).toMatchObject({
      event_id: 'unknown-1', usage_status: 'unknown', input_tokens: null,
      output_tokens: null, reasoning_tokens: null, total_tokens: null,
    });
    expect(usage.summarizeTokenUsage('u1')).toMatchObject({
      calls: 1, unknown_calls: 1, input_tokens: null, total_tokens: null,
    });
  });

  it('idempotently upserts a duplicate event and survives a database reopen', async () => {
    const usage = await import('../../../src/main/features/token_usage');
    const base = {
      eventId: 'same-event', startedAt: 10, finishedAt: 20,
      provider: 'openai', model: 'gpt-test', source: 'core' as const,
      callType: 'provider' as const, status: 'completed' as const,
      projectId: 'project-1', agentId: 'agent-1', taskId: 'task-1', sessionId: 'session-1',
    };
    usage.saveTokenUsage('u1', { ...base, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
    usage.saveTokenUsage('u1', { ...base, finishedAt: 30,
      usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, totalTokens: 8 } });
    expect(usage.summarizeTokenUsage('u1')).toMatchObject({ calls: 1, known_calls: 1, total_tokens: 8 });

    usage.closeTokenUsageDatabases();
    const [row] = usage.listTokenUsage('u1', { projectId: 'project-1' });
    expect(row).toMatchObject({ event_id: 'same-event', finished_at: 30, cache_read_tokens: 2 });
  });

  it('deduplicates cumulative CLI snapshots and handles a counter reset', async () => {
    const { CumulativeUsageAccumulator } = await import('../../../src/main/features/token_usage');
    const acc = new CumulativeUsageAccumulator();
    expect(acc.delta({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })).toMatchObject({
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    expect(acc.delta({ input_tokens: 12, output_tokens: 8, total_tokens: 20 })).toMatchObject({
      inputTokens: 2, outputTokens: 3, totalTokens: 5,
    });
    expect(acc.delta({ input_tokens: 12, output_tokens: 8, total_tokens: 20 })).toMatchObject({
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
    expect(acc.delta({ input_tokens: 3, output_tokens: 2, total_tokens: 5 })).toMatchObject({
      inputTokens: 3, outputTokens: 2, totalTokens: 5,
    });
    expect(acc.delta(undefined)).toBeNull();
    expect(acc.total()).toMatchObject({ inputTokens: 15, outputTokens: 10, totalTokens: 25 });
  });

  it('keeps CLI providers and run counts separate while summing attempt details once', async () => {
    const usage = await import('../../../src/main/features/token_usage');
    const base = { startedAt: 1, finishedAt: 2, source: 'cli' as const,
      callType: 'cli' as const, model: 'unknown', status: 'completed' as const };
    usage.saveTokenUsage('u1', { ...base, eventId: 'codex-1', provider: 'codex', runId: 'run-codex',
      attemptIndex: 1, usage: { input: 6, output: 4 } });
    usage.saveTokenUsage('u1', { ...base, eventId: 'codex-2', provider: 'codex', runId: 'run-codex',
      attemptIndex: 2, usage: { input: 12, output: 8 } });
    usage.saveTokenUsage('u1', { ...base, eventId: 'grok-1', provider: 'grok', runId: 'run-grok',
      attemptIndex: 1, usage: null });

    expect(usage.summarizeTokenUsage('u1', { provider: 'codex' })).toMatchObject({
      calls: 2, cli_attempts: 2, cli_runs: 1, total_tokens: 30, unknown_calls: 0,
    });
    expect(usage.summarizeTokenUsage('u1', { provider: 'grok' })).toMatchObject({
      calls: 1, cli_attempts: 1, cli_runs: 1, total_tokens: null, unknown_calls: 1,
    });
    expect(usage.listTokenUsage('u1', { runId: 'run-codex' })).toHaveLength(2);
  });

  it('builds dashboard totals from stored provider totals without adding cache twice', async () => {
    const usage = await import('../../../src/main/features/token_usage');
    const day = Date.UTC(2026, 10, 6, 4, 0, 0);
    usage.saveTokenUsage('u1', {
      eventId: 'grok-chat', startedAt: day, finishedAt: day + 1_000,
      provider: 'grok-build', model: 'grok-4.7-build-fast', source: 'core',
      callType: 'provider', status: 'completed', agentId: 'agent-grok',
      projectId: 'project-a', taskId: 'task-a',
      usage: { inputTokens: 24_015, outputTokens: 303, cacheReadTokens: 2_048, totalTokens: 26_366 },
    });
    const cliBase = {
      startedAt: day + 2_000, finishedAt: day + 3_000, provider: 'codex', model: 'gpt-test',
      source: 'cli' as const, callType: 'cli' as const, status: 'completed' as const, runId: 'codex-run',
    };
    usage.saveTokenUsage('u1', { ...cliBase, eventId: 'codex-attempt-1', attemptIndex: 1, usage: { input: 6, output: 4 } });
    usage.saveTokenUsage('u1', { ...cliBase, eventId: 'codex-attempt-2', attemptIndex: 2, usage: { input: 12, output: 8 } });
    usage.saveTokenUsage('u1', {
      eventId: 'unknown-call', startedAt: day + 4_000, finishedAt: day + 5_000,
      provider: 'other', model: 'unknown-model', source: 'core', callType: 'skill_correction',
      status: 'failed', usage: null,
    });

    const dashboard = usage.queryTokenDashboard('u1', {
      from: Date.UTC(2026, 10, 6), to: Date.UTC(2026, 10, 7), timezoneOffsetMinutes: 480,
    }) as any;
    expect(dashboard.summary).toMatchObject({
      total_calls: 4, known_usage_calls: 3, unknown_usage_calls: 1,
      total_tokens: 26_396, cache_read_tokens: 2_048, cli_attempts: 2, cli_runs: 1,
      coverage_rate: 0.75,
    });
    expect(dashboard.rankings.providers.find((row: any) => row.name === 'grok-build')).toMatchObject({
      total_tokens: 26_366, input_tokens: 24_015, output_tokens: 303, cache_read_tokens: 2_048,
    });
    expect(dashboard.catalog.call_types).toEqual(expect.arrayContaining(['provider', 'cli', 'skill_correction']));

    const grok = usage.queryTokenDashboard('u1', {
      from: Date.UTC(2026, 10, 6), to: Date.UTC(2026, 10, 7), timezoneOffsetMinutes: 480,
      provider: 'grok-build', agentId: 'agent-grok', projectId: 'project-a', taskId: 'task-a',
    }) as any;
    expect(grok.summary).toMatchObject({ total_calls: 1, total_tokens: 26_366, cache_read_tokens: 2_048 });

    const codex = usage.queryTokenDashboard('u1', {
      from: Date.UTC(2026, 10, 6), to: Date.UTC(2026, 10, 7), provider: 'codex',
    }) as any;
    expect(codex.summary).toMatchObject({ total_calls: 2, total_tokens: 30, cli_attempts: 2, cli_runs: 1 });

    const unknown = usage.queryTokenDashboard('u1', {
      from: Date.UTC(2026, 10, 6), to: Date.UTC(2026, 10, 7), provider: 'other',
    }) as any;
    expect(unknown.summary).toMatchObject({ total_calls: 1, unknown_usage_calls: 1, total_tokens: null });

    usage.closeTokenUsageDatabases();
    const reopened = usage.queryTokenDashboard('u1', {
      from: Date.UTC(2026, 10, 6), to: Date.UTC(2026, 10, 7), provider: 'grok-build',
    }) as any;
    expect(reopened.summary.total_tokens).toBe(26_366);
  });
});
