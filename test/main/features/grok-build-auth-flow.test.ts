import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const grok = vi.hoisted(() => ({
  inspect: vi.fn(),
  spawn: vi.fn(),
  validate: vi.fn(),
}));

vi.mock('../../../src/main/model/core-agent/grok-build-provider', () => ({
  inspectGrokBuildLogin: grok.inspect,
  spawnGrokBuildLogin: grok.spawn,
  validateGrokBuildLogin: grok.validate,
}));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('Grok Build official authorization flow', () => {
  let tmpDir: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-grok-auth-'));
    previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
    process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
    vi.resetModules();
    grok.inspect.mockReset();
    grok.spawn.mockReset();
    grok.validate.mockReset();
    const users = await import('../../../src/main/features/users');
    users.activateUser('99999999');
  });

  afterEach(() => {
    process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes status after the official CLI exits successfully', async () => {
    const child = fakeChild();
    grok.spawn.mockResolvedValue(child);
    grok.inspect.mockResolvedValue({ state: 'authenticated', authenticated: true });
    const auth = await import('../../../src/main/features/auth');
    const started = await auth.startOAuth('grok-build');

    await vi.waitFor(() => expect(grok.spawn).toHaveBeenCalledTimes(1));
    child.emit('close', 0);
    await vi.waitFor(() => expect(auth.pollOAuthFlow(started.flowId).status)
      .toEqual({ kind: 'done', localCli: true }));
  });

  it('settles with a clear error when the CLI login fails', async () => {
    const child = fakeChild();
    grok.spawn.mockResolvedValue(child);
    const auth = await import('../../../src/main/features/auth');
    const started = await auth.startOAuth('grok-build');

    await vi.waitFor(() => expect(grok.spawn).toHaveBeenCalledTimes(1));
    child.emit('close', 1);
    await vi.waitFor(() => {
      const status = auth.pollOAuthFlow(started.flowId).status;
      expect(status.kind).toBe('error');
      if (status.kind === 'error') expect(status.error).toContain('cancelled or failed');
    });
  });

  it('times out instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      grok.spawn.mockResolvedValue(child);
      const auth = await import('../../../src/main/features/auth');
      const started = await auth.startOAuth('grok-build');
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const status = auth.pollOAuthFlow(started.flowId).status;
      expect(status.kind).toBe('error');
      if (status.kind === 'error') expect(status.error).toContain('timed out');
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
