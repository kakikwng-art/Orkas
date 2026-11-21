import {
  countTokenUsage,
  listTokenUsage,
  queryTokenDashboard,
  summarizeTokenUsage,
  type TokenDashboardQuery,
  type TokenUsageQuery,
} from '../features/token_usage';

function queryOf(payload: any): TokenUsageQuery {
  const query: TokenUsageQuery = {};
  for (const key of ['projectId', 'taskId', 'conversationId', 'sessionId', 'agentId', 'provider', 'model', 'runId'] as const) {
    if (typeof payload?.[key] === 'string' && payload[key].trim()) query[key] = payload[key].trim();
  }
  if (payload?.source === 'core' || payload?.source === 'cli') query.source = payload.source;
  if (['provider', 'cli', 'web_app_generate', 'skill_correction', 'dispatch_planner'].includes(payload?.callType)) {
    query.callType = payload.callType;
  }
  if (['completed', 'failed', 'cancelled'].includes(payload?.status)) query.status = payload.status;
  if (payload?.usageStatus === 'known' || payload?.usageStatus === 'unknown') query.usageStatus = payload.usageStatus;
  for (const key of ['from', 'to', 'limit', 'offset'] as const) {
    const value = Number(payload?.[key]);
    if (Number.isFinite(value) && value >= 0) query[key] = Math.trunc(value);
  }
  return query;
}

/** Read-only query surface for the later Token dashboard. */
export const invokeHandlers = {
  'tokenUsage.list': async (payload: any, ctx: any) => ({
    items: listTokenUsage(ctx.userId, queryOf(payload)),
    total: countTokenUsage(ctx.userId, queryOf(payload)),
  }),
  'tokenUsage.summary': async (payload: any, ctx: any) => ({
    summary: summarizeTokenUsage(ctx.userId, queryOf(payload)),
  }),
  'tokenUsage.dashboard': async (payload: any, ctx: any) => {
    const query: TokenDashboardQuery = queryOf(payload);
    query.allTime = payload?.allTime === true;
    const timezoneOffsetMinutes = Number(payload?.timezoneOffsetMinutes);
    if (Number.isFinite(timezoneOffsetMinutes)) query.timezoneOffsetMinutes = Math.trunc(timezoneOffsetMinutes);
    const topLimit = Number(payload?.topLimit);
    if (Number.isFinite(topLimit) && topLimit > 0) query.topLimit = Math.trunc(topLimit);
    return { dashboard: queryTokenDashboard(ctx.userId, query) };
  },
};
