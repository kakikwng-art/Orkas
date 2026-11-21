/**
 * Grok Build backend — uses xAI's official ACP server (`grok agent stdio`).
 * Browser login remains owned by the CLI, so eligible Grok subscription usage
 * is consumed by the official client rather than by an xAI API key in Orkas.
 */

import { makeAcpBackend } from './_acp.js';

export const grokBackend = makeAcpBackend({
  logName: 'local-agents:grok',
  argv: ['agent', 'stdio'],
  clientName: 'orkas',
  diagnoseUsageOnce: true,
});
