import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
let previousRoot: string | undefined;
const UID = 'export-user';
const CID = 'export-chat';

function write(relativePath: string, contents: string | Buffer): void {
  const target = path.join(root, UID, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conversation-export-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('conversation JSON export', () => {
  it('exports messages, process events, group state, sessions and tool results but not attachments or apps', async () => {
    write('cloud/chats/_index.json', JSON.stringify([{ conversation_id: CID, title: 'Export me' }]));
    write(`cloud/chats/${CID}.jsonl`, [
      JSON.stringify({ id: 'm1', from: 'user', to: 'commander', text: 'hello' }),
      JSON.stringify({ id: 'm2', from: 'commander', to: 'user', text: 'done', process: [
        { type: 'event', event: { stream: 'tool', data: { name: 'read_files', phase: 'end' } } },
      ] }),
    ].join('\n') + '\n');
    write(`cloud/chats/${CID}/members.json`, JSON.stringify({ version: 1, actors: [{ id: 'commander' }] }));
    write(`cloud/chats/${CID}/state.json`, JSON.stringify({ floor: 'user' }));
    write(`cloud/chats/${CID}/tasks.json`, JSON.stringify([{ id: 't1', status: 'completed' }]));
    write(`cloud/sessions/gconv-${CID}.jsonl`, `${JSON.stringify({ role: 'user', content: 'hello' })}\n`);
    write(`cloud/sessions/gconv-${CID}.jsonl.context.json`, JSON.stringify({ version: 1 }));
    write(`cloud/sessions/gconv-${CID}.tool-results/result.txt`, 'full tool output');
    write(`cloud/sessions/gmember-${CID}-agent1.jsonl`, `${JSON.stringify({ role: 'assistant', content: 'agent result' })}\n`);
    write(`cloud/chat_attachments/${CID}/private.txt`, 'not part of a chat-record export');
    write(`cloud/chat_artifacts/${CID}/app/index.html`, '<p>not exported</p>');

    const { buildConversationExport } = await import('../../../src/main/features/conversation_export');
    const bundle = await buildConversationExport(UID, CID, null, {
      conversation_id: CID, title: 'Export me', project_id: '',
    });

    expect(bundle.messages).toHaveLength(2);
    expect((bundle.messages[1] as any).process[0].event.stream).toBe('tool');
    const paths = bundle.execution.source_files.map(file => file.relative_path);
    expect(paths).toContain(`cloud/chats/${CID}/members.json`);
    expect(paths).toContain(`cloud/chats/${CID}/tasks.json`);
    expect(paths).toContain(`cloud/sessions/gconv-${CID}.jsonl`);
    expect(paths).toContain(`cloud/sessions/gconv-${CID}.tool-results/result.txt`);
    expect(paths).toContain(`cloud/sessions/gmember-${CID}-agent1.jsonl`);
    expect(paths.some(file => file.includes('chat_attachments'))).toBe(false);
    expect(paths.some(file => file.includes('chat_artifacts'))).toBe(false);
    expect(bundle.execution.source_files.find(file => file.relative_path.endsWith('result.txt'))?.data)
      .toBe('full tool output');
  });

  it('writes readable JSON and sanitizes the suggested filename', async () => {
    const { conversationExportFilename, writeConversationExport } = await import('../../../src/main/features/conversation_export');
    expect(conversationExportFilename('A/B: test?', CID)).toBe(`A_B_ test_-${CID}.json`);
    const target = path.join(root, 'exports', 'conversation.json');
    await writeConversationExport(target, {
      format: 'orkas-conversation-export', version: 1, exported_at: '2026-11-06T00:00:00.000Z',
      conversation: { conversation_id: CID }, messages: [{ text: 'hello' }],
      execution: { source_files: [] },
    });
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).messages).toEqual([{ text: 'hello' }]);
  });
});
