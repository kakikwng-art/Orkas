import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { chromium, expect, test } from '@playwright/test';

test.describe('Token dashboard', () => {
  test('opens, filters, refreshes, and drills into exact provider totals', async ({}, testInfo) => {
    let executablePath = chromium.executablePath();
    if (!existsSync(executablePath) && process.platform === 'win32') {
      const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
      const candidates = existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse() : [];
      const fallback = candidates.map((name) => path.join(root, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')).find(existsSync);
      if (fallback) executablePath = fallback;
    }
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
    const index = readFileSync(path.resolve('src/renderer/index.html'), 'utf8');
    const start = index.indexOf('<section class="panel" id="panel-token-dashboard">');
    const end = index.indexOf('<!-- Settings -->', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const panel = index.slice(start, end).replace('class="panel"', 'class="panel active"');
    await page.setContent(`<div class="app-container"><main class="main-content">${panel}</main></div>`);
    await page.addStyleTag({ path: path.resolve('src/renderer/style.css') });
    await page.evaluate(() => {
      const grok = {
        event_id: 'e2e-grok', started_at: Date.now(), finished_at: Date.now(),
        provider: 'grok-build', model: 'grok-4.7-build-fast', normalized_model: 'grok-4.7-build-fast',
        source: 'core', call_type: 'provider', status: 'completed', usage_status: 'known',
        input_tokens: 24_015, output_tokens: 303, cache_read_tokens: 2_048,
        cache_write_tokens: null, reasoning_tokens: null, total_tokens: 26_366,
        agent_id: 'e2e-agent', project_id: 'e2e-project', task_id: 'e2e-task',
      };
      const unknown = {
        ...grok, event_id: 'e2e-unknown', provider: 'unknown-provider', model: 'unknown-model',
        call_type: 'skill_correction', status: 'failed', usage_status: 'unknown', input_tokens: null,
        output_tokens: null, cache_read_tokens: null, total_tokens: null,
      };
      const summary = (filtered: boolean) => ({
        total_calls: filtered ? 1 : 2, known_usage_calls: 1, unknown_usage_calls: filtered ? 0 : 1,
        completed_calls: 1, known_completed_calls: 1, failed_calls: filtered ? 0 : 1,
        cancelled_calls: 0, cli_attempts: 0, cli_runs: 0, input_tokens: 24_015,
        output_tokens: 303, cache_read_tokens: 2_048, cache_write_tokens: null,
        reasoning_tokens: null, total_tokens: 26_366, coverage_rate: filtered ? 1 : .5,
      });
      const dashboard = (filtered: boolean) => ({
        summary: summary(filtered), today: summary(filtered),
        comparison: {
          previous_period: { total_tokens: { current: 26_366, previous: 20_000, percent_change: 31.83 } },
          year_over_year: { total_tokens: { current: 26_366, previous: 18_000, percent_change: 46.48 } },
        },
        trend: [{ date: new Date().toISOString().slice(0, 10), ...summary(filtered) }],
        anomalies: [],
        rankings: {
          models: [{ name: 'grok-4.7-build-fast', ...summary(true) }],
          providers: [{ name: 'grok-build', ...summary(true) }],
        },
        catalog: {
          models: ['grok-4.7-build-fast', 'unknown-model'], providers: ['grok-build', 'unknown-provider'],
          agents: ['e2e-agent'], projects: ['e2e-project'], tasks: ['e2e-task'],
          call_types: ['provider', 'skill_correction'],
        },
      });
      (window as any).orkas = {
        invoke: async (channel: string, payload: any) => channel === 'tokenUsage.dashboard'
          ? { dashboard: dashboard(payload?.provider === 'grok-build') }
          : { items: payload?.provider === 'unknown-provider' ? [unknown] : [grok], total: 1 },
      };
    });
    await page.addScriptTag({ path: path.resolve('src/renderer/modules/token-dashboard.js') });
    await page.evaluate(() => (window as any).onEnterTokenDashboard());

    await expect(page.locator('#token-total')).toHaveText('26,366');
    await expect(page.locator('#token-unknown-calls')).toHaveText('未知 1 次');
    await expect(page.locator('#token-cache')).toHaveText('2.05K / —');
    await expect(page.locator('#token-model-ranking')).toContainText('grok-4.7-build-fast');

    await page.locator('#token-provider-filter').selectOption('grok-build');
    await expect(page.locator('#token-call-count')).toHaveText('1');
    await expect(page.locator('#token-total')).toHaveText('26,366');

    await page.locator('#token-refresh-btn').click();
    await expect(page.locator('#token-total')).toHaveText('26,366');

    await page.locator('#token-provider-ranking .token-rank-row', { hasText: 'grok-build' }).click();
    await expect(page.locator('#token-detail-overlay')).toHaveClass(/\bis-visible\b/);
    await expect(page.locator('#token-detail-summary')).toContainText('26,366 Token');
    await expect(page.locator('#token-detail-list')).toContainText('输入 24K');
    await page.locator('#token-detail-close').click();
    await page.locator('.token-dashboard-scroll').evaluate((node) => { node.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('token-dashboard.png'), fullPage: true });

    await page.evaluate(async () => {
      const empty = {
        total_calls: 0, known_usage_calls: 0, unknown_usage_calls: 0, completed_calls: 0,
        known_completed_calls: 0, failed_calls: 0, cancelled_calls: 0, cli_attempts: 0,
        cli_runs: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null,
        cache_write_tokens: null, reasoning_tokens: null, total_tokens: null, coverage_rate: null,
      };
      (window as any).orkas.invoke = async () => ({ dashboard: {
        summary: empty, today: empty,
        comparison: { previous_period: { total_tokens: {} }, year_over_year: { total_tokens: {} } },
        trend: [], anomalies: [], rankings: { models: [], providers: [] },
        catalog: { models: [], providers: [], agents: [], projects: [], tasks: [], call_types: [] },
      } });
      await (window as any).TokenDashboard.load();
    });
    await expect(page.locator('#token-total')).toHaveText('0');
    await expect(page.locator('#token-coverage')).toHaveText('—');
    await expect(page.locator('#token-trend-chart')).toContainText('还没有 Token 调用');

    await page.evaluate(async () => {
      const unknown = {
        total_calls: 1, known_usage_calls: 0, unknown_usage_calls: 1, completed_calls: 0,
        known_completed_calls: 0, failed_calls: 1, cancelled_calls: 0, cli_attempts: 0,
        cli_runs: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null,
        cache_write_tokens: null, reasoning_tokens: null, total_tokens: null, coverage_rate: 0,
      };
      (window as any).orkas.invoke = async () => ({ dashboard: {
        summary: unknown, today: unknown,
        comparison: { previous_period: { total_tokens: {} }, year_over_year: { total_tokens: {} } },
        trend: [{ date: new Date().toISOString().slice(0, 10), ...unknown }],
        anomalies: [], rankings: { models: [], providers: [] },
        catalog: { models: [], providers: [], agents: [], projects: [], tasks: [], call_types: [] },
      } });
      await (window as any).TokenDashboard.load();
    });
    await expect(page.locator('#token-total')).toHaveText('未知');
    await expect(page.locator('#token-input')).toHaveText('—');
    await expect(page.locator('#token-trend-chart')).toContainText('usage 均未知');
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.locator('.token-hero-grid')).toHaveCSS('grid-template-columns', /.+/);
    expect(await page.locator('.token-dashboard-scroll').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
