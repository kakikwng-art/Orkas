/**
 * Privacy-minimal ledger for actual model calls.
 *
 * Deliberately stores no prompt, response, error body, key, or tool payload.
 * One row is one attempted upstream call; unknown usage remains NULL rather
 * than being converted to a misleading zero.
 */
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { userTokenUsageDbPath, userTokenUsageDir } from '../paths';

export type TokenCallStatus = 'completed' | 'failed' | 'cancelled';
export type TokenUsageStatus = 'known' | 'unknown';
export type TokenCallType =
  | 'provider'
  | 'cli'
  | 'web_app_generate'
  | 'skill_correction'
  | 'dispatch_planner';

export interface RawTokenUsage {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheCreate?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
}

export interface NormalizedTokenUsage {
  usageStatus: TokenUsageStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface TokenUsageEvent {
  eventId: string;
  startedAt: number;
  finishedAt: number;
  provider: string;
  model: string;
  source: 'core' | 'cli';
  callType: TokenCallType;
  status: TokenCallStatus;
  usage?: RawTokenUsage | null;
  projectId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
  turnId?: string | number | null;
  agentId?: string | null;
  actorId?: string | null;
  callId?: string | null;
  parentRequestId?: string | null;
  attemptIndex?: number | null;
  candidateIndex?: number | null;
  profileId?: string | null;
  runId?: string | null;
}

export interface TokenUsageQuery {
  projectId?: string;
  taskId?: string;
  conversationId?: string;
  sessionId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  source?: 'core' | 'cli';
  callType?: TokenCallType;
  status?: TokenCallStatus;
  usageStatus?: TokenUsageStatus;
  runId?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export interface TokenDashboardQuery extends TokenUsageQuery {
  allTime?: boolean;
  timezoneOffsetMinutes?: number;
  topLimit?: number;
}

type Db = InstanceType<typeof Database>;
const databases = new Map<string, Db>();

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function firstCount(row: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = tokenCount(row[name]);
    if (value !== null) return value;
  }
  return null;
}

/** AionsHome-compatible spelling normalization, without estimates. */
export function normalizeTokenUsage(raw: RawTokenUsage | null | undefined): NormalizedTokenUsage {
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const inputTokens = firstCount(row, ['inputTokens', 'input_tokens', 'prompt_tokens', 'input']);
  const outputTokens = firstCount(row, ['outputTokens', 'output_tokens', 'completion_tokens', 'output']);
  const cacheReadTokens = firstCount(row, ['cacheReadTokens', 'cache_read_tokens', 'cached_tokens', 'cacheRead']);
  const cacheWriteTokens = firstCount(row, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreate']);
  const reasoningTokens = firstCount(row, ['reasoningTokens', 'reasoning_tokens']);
  let totalTokens = firstCount(row, ['totalTokens', 'total_tokens']);
  // This is an exact arithmetic identity only when both components are known.
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }
  const usageStatus: TokenUsageStatus = inputTokens !== null || outputTokens !== null || totalTokens !== null
    ? 'known'
    : 'unknown';
  return { usageStatus, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens };
}

function open(uid: string): Db {
  const file = userTokenUsageDbPath(uid);
  const existing = databases.get(file);
  if (existing) return existing;
  fs.mkdirSync(userTokenUsageDir(uid), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      event_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      normalized_model TEXT NOT NULL,
      source TEXT NOT NULL,
      call_type TEXT NOT NULL,
      status TEXT NOT NULL,
      usage_status TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      total_tokens INTEGER,
      user_id TEXT NOT NULL,
      project_id TEXT,
      task_id TEXT,
      conversation_id TEXT,
      session_id TEXT,
      turn_id TEXT,
      agent_id TEXT,
      actor_id TEXT,
      call_id TEXT,
      parent_request_id TEXT,
      attempt_index INTEGER,
      candidate_index INTEGER,
      profile_id TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(started_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(project_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_task ON token_usage(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id, started_at);
  `);
  const columns = db.pragma('table_info(token_usage)') as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'run_id')) {
    db.exec('ALTER TABLE token_usage ADD COLUMN run_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_run ON token_usage(run_id, started_at)');
  databases.set(file, db);
  return db;
}

function normalizedModel(model: string): string {
  return model.trim().toLowerCase();
}

/** Idempotent event upsert. Re-observing a terminal event updates, never adds. */
export function saveTokenUsage(uid: string, event: TokenUsageEvent): void {
  const usage = normalizeTokenUsage(event.usage);
  const now = Date.now();
  open(uid).prepare(`
    INSERT INTO token_usage (
      event_id, started_at, finished_at, provider, model, normalized_model,
      source, call_type, status, usage_status, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
      user_id, project_id, task_id, conversation_id, session_id, turn_id,
      agent_id, actor_id, call_id, parent_request_id, attempt_index,
      candidate_index, profile_id, run_id, created_at, updated_at
    ) VALUES (
      @eventId, @startedAt, @finishedAt, @provider, @model, @normalizedModel,
      @source, @callType, @status, @usageStatus, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @reasoningTokens, @totalTokens,
      @userId, @projectId, @taskId, @conversationId, @sessionId, @turnId,
      @agentId, @actorId, @callId, @parentRequestId, @attemptIndex,
      @candidateIndex, @profileId, @runId, @createdAt, @updatedAt
    ) ON CONFLICT(event_id) DO UPDATE SET
      finished_at=excluded.finished_at, provider=excluded.provider,
      model=excluded.model, normalized_model=excluded.normalized_model,
      status=excluded.status, usage_status=excluded.usage_status,
      input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      cache_read_tokens=excluded.cache_read_tokens,
      cache_write_tokens=excluded.cache_write_tokens,
      reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens,
      run_id=excluded.run_id,
      updated_at=excluded.updated_at
  `).run({
    ...event,
    normalizedModel: normalizedModel(event.model),
    userId: uid,
    projectId: event.projectId ?? null,
    taskId: event.taskId ?? null,
    conversationId: event.conversationId ?? null,
    sessionId: event.sessionId ?? null,
    turnId: event.turnId == null ? null : String(event.turnId),
    agentId: event.agentId ?? null,
    actorId: event.actorId ?? null,
    callId: event.callId ?? null,
    parentRequestId: event.parentRequestId ?? null,
    attemptIndex: event.attemptIndex ?? null,
    candidateIndex: event.candidateIndex ?? null,
    profileId: event.profileId ?? null,
    runId: event.runId ?? null,
    createdAt: now,
    updatedAt: now,
    ...usage,
  });
}

function whereFor(query: TokenUsageQuery): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const fields: Array<[keyof TokenUsageQuery, string]> = [
    ['projectId', 'project_id'], ['taskId', 'task_id'], ['conversationId', 'conversation_id'],
    ['sessionId', 'session_id'], ['agentId', 'agent_id'], ['provider', 'provider'],
    ['model', 'model'], ['source', 'source'], ['callType', 'call_type'],
    ['status', 'status'], ['usageStatus', 'usage_status'], ['runId', 'run_id'],
  ];
  for (const [key, column] of fields) {
    if (query[key] !== undefined) { clauses.push(`${column}=@${key}`); params[key] = query[key]; }
  }
  if (query.from !== undefined) { clauses.push('started_at>=@from'); params.from = query.from; }
  if (query.to !== undefined) { clauses.push('started_at<@to'); params.to = query.to; }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export function countTokenUsage(uid: string, query: TokenUsageQuery = {}): number {
  const { sql, params } = whereFor(query);
  const row = open(uid).prepare(`SELECT COUNT(*) AS total FROM token_usage${sql}`).get(params) as { total: number };
  return row.total;
}

export function listTokenUsage(uid: string, query: TokenUsageQuery = {}): Record<string, unknown>[] {
  const { sql, params } = whereFor(query);
  const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  return open(uid).prepare(`SELECT * FROM token_usage${sql} ORDER BY started_at DESC, event_id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as Record<string, unknown>[];
}

export function summarizeTokenUsage(uid: string, query: TokenUsageQuery = {}): Record<string, number | null> {
  const { sql, params } = whereFor(query);
  const row = open(uid).prepare(`
    SELECT COUNT(*) AS calls,
      COUNT(CASE WHEN source='cli' THEN 1 END) AS cli_attempts,
      COUNT(DISTINCT CASE WHEN source='cli' THEN run_id END) AS cli_runs,
      SUM(CASE WHEN usage_status='known' THEN 1 ELSE 0 END) AS known_calls,
      SUM(CASE WHEN usage_status='unknown' THEN 1 ELSE 0 END) AS unknown_calls,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(reasoning_tokens) AS reasoning_tokens,
      SUM(total_tokens) AS total_tokens
    FROM token_usage${sql}
  `).get(params) as Record<string, number | null>;
  return row;
}

const DASHBOARD_AGGREGATE_SQL = `
  COUNT(*) AS total_calls,
  SUM(CASE WHEN usage_status='known' THEN 1 ELSE 0 END) AS known_usage_calls,
  SUM(CASE WHEN usage_status='unknown' THEN 1 ELSE 0 END) AS unknown_usage_calls,
  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_calls,
  SUM(CASE WHEN status='completed' AND usage_status='known' THEN 1 ELSE 0 END) AS known_completed_calls,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_calls,
  SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_calls,
  SUM(CASE WHEN source='cli' THEN 1 ELSE 0 END) AS cli_attempts,
  COUNT(DISTINCT CASE WHEN source='cli' THEN run_id END) AS cli_runs,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(reasoning_tokens) AS reasoning_tokens,
  SUM(total_tokens) AS total_tokens
`;

type DashboardRow = Record<string, number | string | null>;

function withCoverage(row: DashboardRow): DashboardRow {
  const calls = Number(row.total_calls ?? 0);
  const known = Number(row.known_usage_calls ?? 0);
  const completed = Number(row.completed_calls ?? 0);
  const knownCompleted = Number(row.known_completed_calls ?? 0);
  return {
    ...row,
    coverage_rate: calls ? known / calls : null,
    completed_coverage_rate: completed ? knownCompleted / completed : null,
  };
}

function summaryFor(db: Db, query: TokenUsageQuery): DashboardRow {
  const { sql, params } = whereFor(query);
  const row = db.prepare(`SELECT ${DASHBOARD_AGGREGATE_SQL} FROM token_usage${sql}`).get(params) as DashboardRow;
  return withCoverage(row);
}

function change(current: unknown, previous: unknown): Record<string, number | null> {
  const now = Number(current ?? 0);
  const before = Number(previous ?? 0);
  return {
    current: now,
    previous: before,
    absolute_change: now - before,
    percent_change: before ? ((now - before) / before) * 100 : null,
  };
}

function comparison(current: DashboardRow, reference: DashboardRow): Record<string, unknown> {
  const coverage = typeof current.coverage_rate === 'number' ? current.coverage_rate : null;
  const referenceCoverage = typeof reference.coverage_rate === 'number' ? reference.coverage_rate : null;
  return {
    summary: reference,
    total_tokens: change(current.total_tokens, reference.total_tokens),
    total_calls: change(current.total_calls, reference.total_calls),
    known_usage_calls: change(current.known_usage_calls, reference.known_usage_calls),
    coverage_rate_change: coverage !== null && referenceCoverage !== null ? coverage - referenceCoverage : null,
  };
}

function localDayKey(timestamp: number, offsetMinutes: number): string {
  return new Date(timestamp + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function localDayStart(timestamp: number, offsetMinutes: number): number {
  const shifted = new Date(timestamp + offsetMinutes * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMinutes * 60_000;
}

function previousYear(timestamp: number, offsetMinutes: number): number {
  const shifted = new Date(timestamp + offsetMinutes * 60_000);
  const year = shifted.getUTCFullYear() - 1;
  const month = shifted.getUTCMonth();
  const day = Math.min(shifted.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return Date.UTC(year, month, day, shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds(), shifted.getUTCMilliseconds())
    - offsetMinutes * 60_000;
}

function trendFor(db: Db, query: TokenUsageQuery, start: number, end: number, offsetMinutes: number): DashboardRow[] {
  const bounded = { ...query, from: start, to: end };
  const { sql, params } = whereFor(bounded);
  const offsetMs = offsetMinutes * 60_000;
  const rows = db.prepare(`
    SELECT date((started_at + @offsetMs) / 1000, 'unixepoch') AS date, ${DASHBOARD_AGGREGATE_SQL}
    FROM token_usage${sql}
    GROUP BY date
    ORDER BY date
  `).all({ ...params, offsetMs }) as DashboardRow[];
  const found = new Map(rows.map(row => [String(row.date), withCoverage(row)]));
  const result: DashboardRow[] = [];
  for (let cursor = localDayStart(start, offsetMinutes); cursor < end; cursor += 86_400_000) {
    const date = localDayKey(cursor, offsetMinutes);
    result.push(found.get(date) ?? withCoverage({
      date, total_calls: 0, known_usage_calls: 0, unknown_usage_calls: 0,
      completed_calls: 0, known_completed_calls: 0, failed_calls: 0, cancelled_calls: 0,
      cli_attempts: 0, cli_runs: 0, input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, total_tokens: null,
    }));
  }
  return result;
}

function rankingsFor(db: Db, query: TokenUsageQuery, limit: number): Record<string, DashboardRow[]> {
  const { sql, params } = whereFor(query);
  const dimensions = {
    models: 'model', providers: 'provider', agents: 'agent_id', projects: 'project_id',
    tasks: 'task_id', call_types: 'call_type',
  } as const;
  const output: Record<string, DashboardRow[]> = {};
  for (const [label, column] of Object.entries(dimensions)) {
    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(${column}, ''), 'unknown') AS name, ${DASHBOARD_AGGREGATE_SQL}
      FROM token_usage${sql}
      GROUP BY name
      ORDER BY total_tokens IS NULL, total_tokens DESC, total_calls DESC
      LIMIT @limit
    `).all({ ...params, limit }) as DashboardRow[];
    output[label] = rows.map(withCoverage);
  }
  return output;
}

function catalogFor(db: Db): Record<string, string[]> {
  const dimensions = {
    models: 'model', providers: 'provider', agents: 'agent_id', projects: 'project_id',
    tasks: 'task_id', call_types: 'call_type',
  } as const;
  const output: Record<string, string[]> = {};
  for (const [label, column] of Object.entries(dimensions)) {
    const rows = db.prepare(`SELECT DISTINCT ${column} AS value FROM token_usage WHERE ${column} IS NOT NULL AND ${column}!='' ORDER BY ${column}`)
      .all() as Array<{ value: string }>;
    output[label] = rows.map(row => row.value);
  }
  return output;
}

function detectAnomalies(trend: DashboardRow[]): DashboardRow[] {
  const anomalies: DashboardRow[] = [];
  for (let index = 0; index < trend.length; index += 1) {
    const history = trend.slice(Math.max(0, index - 7), index)
      .filter(row => Number(row.total_calls ?? 0) > 0 && typeof row.total_tokens === 'number')
      .map(row => Number(row.total_tokens));
    const row = trend[index];
    if (history.length < 3 || typeof row.total_tokens !== 'number') continue;
    const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
    const variance = history.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / history.length;
    const threshold = Math.max(mean * 1.5, mean + 3 * Math.sqrt(variance));
    if (row.total_tokens > threshold) {
      anomalies.push({
        date: row.date, total_tokens: row.total_tokens, baseline_days: history.length,
        baseline_average: Math.round(mean * 100) / 100, threshold: Math.round(threshold * 100) / 100,
        ratio_to_baseline: mean ? Math.round((row.total_tokens / mean) * 100) / 100 : null,
        coverage_rate: row.coverage_rate, completed_coverage_rate: row.completed_coverage_rate,
      });
    }
  }
  return anomalies;
}

/** Read-only AionsHome-compatible dashboard analytics over OrkaS's independent ledger. */
export function queryTokenDashboard(uid: string, input: TokenDashboardQuery = {}): Record<string, unknown> {
  const db = open(uid);
  const timezoneOffsetMinutes = Math.max(-720, Math.min(840, Math.trunc(input.timezoneOffsetMinutes ?? 0)));
  const topLimit = Math.max(1, Math.min(50, Math.trunc(input.topLimit ?? 20)));
  const now = Date.now();
  const baseQuery: TokenUsageQuery = { ...input };
  delete (baseQuery as TokenDashboardQuery).allTime;
  delete (baseQuery as TokenDashboardQuery).timezoneOffsetMinutes;
  delete (baseQuery as TokenDashboardQuery).topLimit;
  delete baseQuery.limit;
  delete baseQuery.offset;

  let end = input.to ?? now;
  let start = input.from;
  if (input.allTime || start === undefined) {
    const unbounded = { ...baseQuery, from: undefined, to: end };
    const { sql, params } = whereFor(unbounded);
    const first = (db.prepare(`SELECT MIN(started_at) AS value FROM token_usage${sql}`).get(params) as { value: number | null }).value;
    start = first === null ? localDayStart(end, timezoneOffsetMinutes) - 86_400_000 : localDayStart(first, timezoneOffsetMinutes);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start! >= end) throw new Error('invalid token dashboard range');
  const currentQuery = { ...baseQuery, from: start, to: end };
  const duration = end - start!;
  const previousQuery = { ...baseQuery, from: start! - duration, to: start };
  const yearQuery = { ...baseQuery, from: previousYear(start!, timezoneOffsetMinutes), to: previousYear(end, timezoneOffsetMinutes) };
  const todayStart = localDayStart(now, timezoneOffsetMinutes);
  const current = summaryFor(db, currentQuery);
  const trend = trendFor(db, baseQuery, start!, end, timezoneOffsetMinutes);

  return {
    period: { start, end, all_time: Boolean(input.allTime), timezone_offset_minutes: timezoneOffsetMinutes },
    summary: current,
    today: summaryFor(db, { ...baseQuery, from: todayStart, to: todayStart + 86_400_000 }),
    comparison: {
      previous_period: comparison(current, summaryFor(db, previousQuery)),
      year_over_year: comparison(current, summaryFor(db, yearQuery)),
    },
    trend,
    rankings: rankingsFor(db, currentQuery, topLimit),
    anomalies: detectAnomalies(trend),
    catalog: catalogFor(db),
  };
}

/** Test/app-shutdown hook. Reopening verifies on-disk persistence. */
export function closeTokenUsageDatabases(): void {
  for (const db of databases.values()) db.close();
  databases.clear();
}

/** Positive-delta accumulator for CLI backends that report cumulative snapshots. */
export class CumulativeUsageAccumulator {
  private previous: NormalizedTokenUsage | null = null;
  private accumulated: Record<keyof Pick<RawTokenUsage,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'totalTokens'>, number | undefined> = {
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
      totalTokens: undefined,
    };

  delta(raw: RawTokenUsage | null | undefined): RawTokenUsage | null {
    const current = normalizeTokenUsage(raw);
    if (current.usageStatus === 'unknown') return null;
    const prior = this.previous;
    this.previous = current;
    const difference = (now: number | null, before: number | null | undefined): number | undefined => {
      if (now === null) return undefined;
      if (before == null || now < before) return now;
      return now - before;
    };
    const delta: RawTokenUsage = {
      inputTokens: difference(current.inputTokens, prior?.inputTokens),
      outputTokens: difference(current.outputTokens, prior?.outputTokens),
      cacheReadTokens: difference(current.cacheReadTokens, prior?.cacheReadTokens),
      cacheWriteTokens: difference(current.cacheWriteTokens, prior?.cacheWriteTokens),
      reasoningTokens: difference(current.reasoningTokens, prior?.reasoningTokens),
      totalTokens: difference(current.totalTokens, prior?.totalTokens),
    };
    for (const key of Object.keys(this.accumulated) as Array<keyof typeof this.accumulated>) {
      const value = delta[key];
      if (typeof value === 'number') this.accumulated[key] = (this.accumulated[key] ?? 0) + value;
    }
    return delta;
  }

  /** Total of de-duplicated cumulative snapshots observed by this attempt. */
  total(): RawTokenUsage | null {
    if (!Object.values(this.accumulated).some(value => value !== undefined)) return null;
    const total = { ...this.accumulated };
    // Component totals are authoritative when both are available. Cached
    // tokens are a subset/category of input billing and must not be added.
    if (total.inputTokens !== undefined && total.outputTokens !== undefined) {
      total.totalTokens = total.inputTokens + total.outputTokens;
    }
    return total;
  }
}
