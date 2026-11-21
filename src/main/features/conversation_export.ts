/**
 * Portable, read-only conversation export.
 *
 * The canonical chat JSONL already contains every persisted narration and
 * process event. Companion group state and Core/Agent session files are added
 * so the export is useful for later debugging without reopening Orkas. User
 * attachments, generated app bundles, account configuration and credentials
 * are intentionally outside this export.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { conversationFileInventory } from './conversation_deletions';
import { userRoot } from '../paths';

export const CONVERSATION_EXPORT_FORMAT = 'orkas-conversation-export';
export const CONVERSATION_EXPORT_VERSION = 1;

type ExportedSourceFile = {
  relative_path: string;
  format: 'json' | 'jsonl' | 'text' | 'base64';
  size_bytes: number;
  data: unknown;
};

export interface ConversationExportBundle {
  format: typeof CONVERSATION_EXPORT_FORMAT;
  version: typeof CONVERSATION_EXPORT_VERSION;
  exported_at: string;
  conversation: Record<string, unknown>;
  messages: unknown[];
  execution: {
    source_files: ExportedSourceFile[];
  };
}

function parseJsonLines(text: string): unknown[] {
  return text.split(/\r?\n/).filter(line => line.trim().length > 0).map((line, index) => {
    try { return JSON.parse(line); }
    catch { return { _unparsed_line: index + 1, raw: line }; }
  });
}

function utf8RoundTrips(buffer: Buffer): boolean {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer);
}

async function exportSourceFile(root: string, relativePath: string): Promise<ExportedSourceFile> {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  const buffer = await fsp.readFile(absolutePath);
  const size = buffer.byteLength;
  if (relativePath.endsWith('.jsonl')) {
    return { relative_path: relativePath, format: 'jsonl', size_bytes: size, data: parseJsonLines(buffer.toString('utf8')) };
  }
  if (relativePath.endsWith('.json')) {
    const text = buffer.toString('utf8');
    try { return { relative_path: relativePath, format: 'json', size_bytes: size, data: JSON.parse(text) }; }
    catch { return { relative_path: relativePath, format: 'text', size_bytes: size, data: text }; }
  }
  if (utf8RoundTrips(buffer)) {
    return { relative_path: relativePath, format: 'text', size_bytes: size, data: buffer.toString('utf8') };
  }
  return { relative_path: relativePath, format: 'base64', size_bytes: size, data: buffer.toString('base64') };
}

function isConversationRecordFile(relativePath: string, cid: string): boolean {
  const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|/)chats/${escaped}(?:\\.jsonl|/)`).test(relativePath)
    || /(?:^|\/)sessions\//.test(relativePath);
}

/** Build a point-in-time export. The caller owns metadata authorization. */
export async function buildConversationExport(
  uid: string,
  cid: string,
  projectId: string | null,
  conversation: Record<string, unknown>,
): Promise<ConversationExportBundle> {
  const inventory = await conversationFileInventory(uid, cid, projectId);
  const relevant = inventory.files
    .filter(relativePath => isConversationRecordFile(relativePath, cid))
    .sort((a, b) => a.localeCompare(b));
  const root = userRoot(uid);
  const files: ExportedSourceFile[] = [];
  for (const relativePath of relevant) files.push(await exportSourceFile(root, relativePath));

  const messageFile = files.find(file => new RegExp(`(?:^|/)chats/${cid}\\.jsonl$`).test(file.relative_path));
  const messages = messageFile?.format === 'jsonl' && Array.isArray(messageFile.data)
    ? messageFile.data
    : [];
  return {
    format: CONVERSATION_EXPORT_FORMAT,
    version: CONVERSATION_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    conversation: { ...conversation },
    messages,
    execution: {
      // Avoid duplicating the usually largest source: messages above contains
      // the complete canonical records, including every persisted process event.
      source_files: files.filter(file => file !== messageFile),
    },
  };
}

export async function writeConversationExport(filePath: string, bundle: ConversationExportBundle): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
}

export function conversationExportFilename(title: unknown, cid: string): string {
  const safeTitle = String(title || 'conversation')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 96) || 'conversation';
  return `${safeTitle}-${cid}.json`;
}

