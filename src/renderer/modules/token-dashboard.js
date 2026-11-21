(function () {
  'use strict';

  const number = new Intl.NumberFormat('zh-CN');
  const colors = ['#5b57d6', '#438a94', '#b88942', '#9a72aa', '#6683b7', '#ab7279', '#2f9d78', '#d96f75'];
  const state = {
    days: 'all', start: '', end: '', model: '', provider: '', agentId: '',
    projectId: '', taskId: '', callType: '', loaded: false, loading: false, data: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
  const compact = (value) => {
    if (value == null) return '—';
    const n = Number(value);
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.0+$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 1 : 2).replace(/\.0+$/, '')}K`;
    return number.format(n);
  };
  const totalText = (value, calls) => value == null ? (Number(calls || 0) ? '未知' : '0') : number.format(Number(value));
  const percent = (value) => value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
  const localDateValue = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const dateLabel = (value) => {
    const parsed = new Date(`${value}T00:00:00`);
    return `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
  };
  const callTypeLabel = (value) => ({
    provider: 'Core Provider', cli: 'CLI', web_app_generate: 'Web App 生成',
    skill_correction: 'Skill 修复', dispatch_planner: '派发规划',
  })[value] || value || 'unknown';

  function range() {
    if (state.days === 'all') return { allTime: true };
    if (state.days === 'custom') {
      const from = new Date(`${state.start}T00:00:00`).getTime();
      const toDate = new Date(`${state.end}T00:00:00`);
      toDate.setDate(toDate.getDate() + 1);
      return { from, to: toDate.getTime() };
    }
    const to = Date.now();
    return { from: to - Number(state.days) * 86_400_000, to };
  }

  function payload(extra = {}) {
    return {
      ...range(),
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
      topLimit: 20,
      ...(state.model ? { model: state.model } : {}),
      ...(state.provider ? { provider: state.provider } : {}),
      ...(state.agentId ? { agentId: state.agentId } : {}),
      ...(state.projectId ? { projectId: state.projectId } : {}),
      ...(state.taskId ? { taskId: state.taskId } : {}),
      ...(state.callType ? { callType: state.callType } : {}),
      ...extra,
    };
  }

  function setNotice(message = '', isError = false) {
    const node = $('token-notice');
    if (!node) return;
    node.textContent = message;
    node.className = `token-notice${message ? ' is-visible' : ''}${isError ? ' is-error' : ''}`;
  }

  function updatePeriodLabel() {
    $('token-period-label').textContent = state.days === 'all'
      ? '全部数据'
      : state.days === 'custom' ? `${state.start} 至 ${state.end}` : `最近 ${state.days} 天`;
  }

  async function loadTokenDashboard() {
    if (state.loading) return;
    state.loading = true;
    $('token-refresh-btn')?.classList.add('is-loading');
    setNotice('正在读取 Token 账本…');
    try {
      const response = await window.orkas.invoke('tokenUsage.dashboard', payload());
      const dashboard = response?.dashboard;
      if (!dashboard) throw new Error('统计接口没有返回数据');
      state.data = dashboard;
      state.loaded = true;
      render(dashboard);
      setNotice('');
    } catch (error) {
      setNotice(`读取失败：${error?.message || String(error)}`, true);
    } finally {
      state.loading = false;
      $('token-refresh-btn')?.classList.remove('is-loading');
    }
  }

  function comparisonText(change, suffix) {
    if (change?.percent_change == null) return `${suffix} —`;
    const value = Number(change.percent_change);
    return `${suffix} ${value >= 0 ? '↑' : '↓'}${Math.abs(value).toFixed(1)}%`;
  }

  function render(data) {
    const summary = data.summary || {};
    const today = data.today || {};
    $('token-total').textContent = totalText(summary.total_tokens, summary.total_calls);
    $('token-known-calls').textContent = `${number.format(Number(summary.known_usage_calls || 0))} 次有 usage`;
    $('token-today').textContent = totalText(today.total_tokens, today.total_calls);
    $('token-today-calls').textContent = `${number.format(Number(today.total_calls || 0))} 次调用`;
    $('token-call-count').textContent = number.format(Number(summary.total_calls || 0));
    $('token-cli-runs').textContent = `CLI 运行 ${number.format(Number(summary.cli_runs || 0))}`;
    $('token-cli-attempts').textContent = `attempt ${number.format(Number(summary.cli_attempts || 0))}`;
    $('token-input').textContent = compact(summary.input_tokens);
    $('token-output').textContent = compact(summary.output_tokens);
    $('token-cache').textContent = `${compact(summary.cache_read_tokens)} / ${compact(summary.cache_write_tokens)}`;
    $('token-reasoning').textContent = compact(summary.reasoning_tokens);
    $('token-coverage').textContent = percent(summary.coverage_rate);
    $('token-unknown-calls').textContent = `未知 ${number.format(Number(summary.unknown_usage_calls || 0))} 次`;

    const previous = data.comparison?.previous_period?.total_tokens;
    const yoy = data.comparison?.year_over_year?.total_tokens;
    const chip = $('token-period-change');
    chip.textContent = comparisonText(previous, '环比');
    chip.classList.toggle('is-down', Number(previous?.percent_change) < 0);
    $('token-comparison-summary').textContent = `${comparisonText(previous, '环比')} · ${comparisonText(yoy, '同比')}`;

    renderTrend(data.trend || [], data.anomalies || []);
    renderAnomalies(data.anomalies || []);
    renderRanking('token-model-ranking', 'token-model-donut', data.rankings?.models || [], 'model');
    renderRanking('token-provider-ranking', 'token-provider-donut', data.rankings?.providers || [], 'provider');
    populateFilters(data.catalog || {});
    updatePeriodLabel();
  }

  function seriesSegments(rows, values, x, y, className) {
    const segments = [];
    let current = [];
    values.forEach((value, index) => {
      if (value == null) {
        if (current.length) segments.push(current);
        current = [];
      } else {
        current.push(`${x(index).toFixed(2)},${y(value).toFixed(2)}`);
      }
    });
    if (current.length) segments.push(current);
    return segments.map((points) => `<polyline class="token-chart-line ${className}" points="${points.join(' ')}"/>`).join('');
  }

  function renderTrend(rows, anomalies) {
    const target = $('token-trend-chart');
    const valueOf = (row, field) => Number(row.total_calls || 0) === 0 ? 0 : (row[field] == null ? null : Number(row[field]));
    const totalValues = rows.map((row) => valueOf(row, 'total_tokens'));
    const inputValues = rows.map((row) => valueOf(row, 'input_tokens'));
    const outputValues = rows.map((row) => valueOf(row, 'output_tokens'));
    const numericValues = [...totalValues, ...inputValues, ...outputValues].filter((value) => value != null);
    if (!rows.length || !numericValues.length || Math.max(...numericValues) === 0) {
      const hasCalls = rows.some((row) => Number(row.total_calls || 0) > 0);
      target.innerHTML = `<div class="token-chart-empty">${hasCalls ? '这个范围有调用，但 Token usage 均未知' : '这个范围内还没有 Token 调用'}</div>`;
      return;
    }
    const width = 900; const height = 240; const left = 48; const right = 14; const top = 16; const bottom = 30;
    const plotW = width - left - right; const plotH = height - top - bottom; const max = Math.max(...numericValues, 1);
    const x = (index) => left + (rows.length === 1 ? plotW / 2 : index * plotW / (rows.length - 1));
    const y = (value) => top + plotH - Number(value) / max * plotH;
    const labelIndexes = [0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1]
      .filter((value, index, array) => array.indexOf(value) === index);
    const grids = [0, 0.5, 1].map((rate) => `<line class="token-chart-grid" x1="${left}" x2="${width - right}" y1="${y(max * rate)}" y2="${y(max * rate)}"/><text class="token-chart-label" x="2" y="${y(max * rate) + 3}">${compact(max * rate)}</text>`).join('');
    const labels = labelIndexes.map((index) => `<text class="token-chart-label" text-anchor="middle" x="${x(index)}" y="${height - 6}">${dateLabel(rows[index].date)}</text>`).join('');
    const anomalyDates = new Set(anomalies.map((item) => item.date));
    const hits = rows.map((row, index) => {
      const pointY = totalValues[index] == null ? top + plotH : y(totalValues[index]);
      const label = totalValues[index] == null ? 'usage 未知' : `${number.format(totalValues[index])} Token`;
      return `<g class="token-trend-hit" tabindex="0" role="button" data-date="${esc(row.date)}" aria-label="${dateLabel(row.date)}，${label}">${anomalyDates.has(row.date) && totalValues[index] != null ? `<circle class="token-chart-point is-anomaly" cx="${x(index)}" cy="${pointY}" r="5"/>` : ''}<circle cx="${x(index)}" cy="${pointY}" r="12" fill="transparent"/></g>`;
    }).join('');
    target.innerHTML = `<svg class="token-trend-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">${grids}${seriesSegments(rows, totalValues, x, y, 'is-total')}${seriesSegments(rows, inputValues, x, y, 'is-input')}${seriesSegments(rows, outputValues, x, y, 'is-output')}${hits}${labels}</svg>`;
    target.querySelectorAll('.token-trend-hit').forEach((node) => {
      const open = () => openDateDetail(node.dataset.date);
      node.addEventListener('click', open);
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });
    });
  }

  function renderAnomalies(items) {
    $('token-anomaly-count').textContent = String(items.length);
    $('token-anomaly-list').innerHTML = items.length ? items.map((item) => `
      <button class="token-anomaly-item" type="button" data-date="${esc(item.date)}">
        <span class="token-anomaly-icon">↗</span><span class="token-anomaly-copy"><strong>${dateLabel(item.date)} · ${number.format(item.total_tokens)} Token</strong><span>近期基线的 ${item.ratio_to_baseline ?? '—'} 倍 · usage 覆盖 ${percent(item.coverage_rate)}</span></span><span>›</span>
      </button>`).join('') : '<div class="token-empty-state">当前范围没有达到规则阈值的异常峰值</div>';
    $('token-anomaly-list').querySelectorAll('[data-date]').forEach((button) => button.addEventListener('click', () => openDateDetail(button.dataset.date)));
  }

  function renderRanking(targetId, donutId, items, type) {
    const knownItems = items.filter((item) => item.total_tokens != null);
    const total = knownItems.reduce((sum, item) => sum + Number(item.total_tokens), 0);
    const max = Math.max(...knownItems.map((item) => Number(item.total_tokens)), 1);
    let cursor = 0;
    const slices = knownItems.slice(0, colors.length).map((item, index) => {
      const start = cursor; const end = total ? cursor + Number(item.total_tokens) / total * 100 : cursor;
      cursor = end;
      return `${colors[index]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    });
    const donut = $(donutId);
    donut.style.background = total ? `conic-gradient(${slices.join(',')})` : 'var(--surface-2)';
    donut.querySelector('strong').textContent = compact(total || 0);
    $(targetId).innerHTML = items.length ? items.slice(0, 10).map((item, index) => {
      const known = item.total_tokens != null;
      const share = total && known ? Number(item.total_tokens) / total * 100 : null;
      const sub = known ? `${share.toFixed(1)}% · ${number.format(Number(item.total_calls || 0))} 次` : `${number.format(Number(item.total_calls || 0))} 次 · usage 未知`;
      return `<button class="token-rank-row" style="--token-rank-color:${colors[index % colors.length]}" type="button" data-name="${esc(item.name)}" data-type="${type}"><span class="token-rank-dot"></span><span class="token-rank-main"><strong>${esc(item.name || 'unknown')}</strong><span>${sub} · 覆盖 ${percent(item.coverage_rate)}</span></span><span class="token-rank-value">${compact(item.total_tokens)}</span><span class="token-rank-bar"><i style="width:${known ? Math.max(3, Number(item.total_tokens) / max * 100) : 0}%"></i></span></button>`;
    }).join('') : '<div class="token-empty-state">暂无排行数据</div>';
    $(targetId).querySelectorAll('.token-rank-row').forEach((button) => button.addEventListener('click', () => openDimensionDetail(button.dataset.type, button.dataset.name)));
  }

  function populateFilters(catalog) {
    const definitions = [
      ['token-model-filter', 'models', 'model', '全部模型'],
      ['token-provider-filter', 'providers', 'provider', '全部 Provider'],
      ['token-agent-filter', 'agents', 'agentId', '全部 Agent'],
      ['token-project-filter', 'projects', 'projectId', '全部项目'],
      ['token-task-filter', 'tasks', 'taskId', '全部任务'],
      ['token-call-type-filter', 'call_types', 'callType', '全部调用类型'],
    ];
    definitions.forEach(([id, key, stateKey, emptyLabel]) => {
      const select = $(id); const current = state[stateKey];
      const options = Array.isArray(catalog[key]) ? catalog[key] : [];
      select.innerHTML = `<option value="">${emptyLabel}</option>` + options.map((value) => `<option value="${esc(value)}">${esc(key === 'call_types' ? callTypeLabel(value) : value)}</option>`).join('');
      select.value = current;
    });
  }

  async function openDetails(title, kicker, extra = {}) {
    $('token-detail-kicker').textContent = kicker;
    $('token-detail-title').textContent = title;
    $('token-detail-summary').textContent = '正在读取明细…';
    $('token-detail-list').innerHTML = '';
    showSheet(true);
    try {
      const response = await window.orkas.invoke('tokenUsage.list', payload({ ...extra, limit: 300, offset: 0, allTime: undefined }));
      const rows = response?.items || [];
      const knownTotalRows = rows.filter((row) => row.total_tokens != null);
      const knownTotal = knownTotalRows.reduce((sum, row) => sum + Number(row.total_tokens), 0);
      const more = Number(response?.total || 0) > rows.length ? ` · 显示最近 ${rows.length}/${response.total} 条` : '';
      $('token-detail-summary').textContent = `${number.format(Number(response?.total || rows.length))} 次调用 · ${knownTotalRows.length} 次有总量 · ${number.format(knownTotal)} Token${more}`;
      $('token-detail-list').innerHTML = rows.length ? rows.map(renderCall).join('') : '<div class="token-empty-state">没有匹配的调用记录</div>';
    } catch (error) {
      $('token-detail-summary').textContent = `读取失败：${error?.message || String(error)}`;
    }
  }

  function renderCall(row) {
    const time = new Date(Number(row.started_at)).toLocaleString('zh-CN', { hour12: false });
    const total = row.total_tokens == null ? 'usage 未知' : `${number.format(row.total_tokens)} Token`;
    const identity = [row.agent_id && `Agent ${row.agent_id}`, row.project_id && `项目 ${row.project_id}`, row.task_id && `任务 ${row.task_id}`].filter(Boolean).join(' · ');
    const cli = row.source === 'cli' ? ` · CLI ${row.run_id ? 'run' : 'attempt'}${row.attempt_index == null ? '' : ` #${row.attempt_index}`}` : '';
    return `<article class="token-call-row"><div><div class="token-call-title">${esc(row.model || row.normalized_model || 'unknown')}</div><div class="token-call-meta">${esc(row.provider || 'unknown')} · ${esc(callTypeLabel(row.call_type))}${cli} · ${time}</div>${identity ? `<div class="token-call-meta">${esc(identity)}</div>` : ''}<span class="token-status-pill is-${esc(row.status)}">${statusText(row.status)}</span></div><div class="token-call-value">${total}<div class="token-call-meta">输入 ${compact(row.input_tokens)} · 输出 ${compact(row.output_tokens)}</div><div class="token-call-meta">缓存读 ${compact(row.cache_read_tokens)} · 写 ${compact(row.cache_write_tokens)} · 推理 ${compact(row.reasoning_tokens)}</div></div></article>`;
  }

  function statusText(status) {
    return ({ completed: '成功', failed: '失败', cancelled: '已取消' })[status] || status || '未知';
  }

  function openDateDetail(date) {
    const from = new Date(`${date}T00:00:00`); const to = new Date(from); to.setDate(to.getDate() + 1);
    openDetails(dateLabel(date), '日期明细', { from: from.getTime(), to: to.getTime() });
  }

  function openDimensionDetail(type, name) {
    openDetails(name, type === 'model' ? '模型明细' : 'Provider 明细', type === 'model' ? { model: name } : { provider: name });
  }

  function showSheet(show) {
    $('token-detail-overlay').classList.toggle('is-visible', show);
    $('token-detail-overlay').setAttribute('aria-hidden', String(!show));
  }

  function bind() {
    const today = new Date(); const monthAgo = new Date(Date.now() - 29 * 86_400_000);
    $('token-start-date').value = localDateValue(monthAgo);
    $('token-end-date').value = localDateValue(today);
    state.start = $('token-start-date').value; state.end = $('token-end-date').value;
    $('token-preset-row').addEventListener('click', (event) => {
      const button = event.target.closest('[data-days]'); if (!button) return;
      state.days = button.dataset.days;
      $('token-preset-row').querySelectorAll('button').forEach((node) => node.classList.toggle('is-active', node === button));
      $('token-custom-range').hidden = state.days !== 'custom';
      if (state.days !== 'custom') loadTokenDashboard();
    });
    $('token-apply-range').addEventListener('click', () => {
      state.start = $('token-start-date').value; state.end = $('token-end-date').value;
      if (!state.start || !state.end || state.start > state.end) { setNotice('请选择有效的开始和结束日期。', true); return; }
      loadTokenDashboard();
    });
    const filters = [
      ['token-model-filter', 'model'], ['token-provider-filter', 'provider'], ['token-agent-filter', 'agentId'],
      ['token-project-filter', 'projectId'], ['token-task-filter', 'taskId'], ['token-call-type-filter', 'callType'],
    ];
    filters.forEach(([id, key]) => $(id).addEventListener('change', (event) => { state[key] = event.target.value; loadTokenDashboard(); }));
    $('token-unknown-calls').addEventListener('click', () => openDetails('usage 未知', '数据质量明细', { usageStatus: 'unknown' }));
    $('token-refresh-btn').addEventListener('click', loadTokenDashboard);
    $('token-detail-close').addEventListener('click', () => showSheet(false));
    $('token-detail-overlay').addEventListener('click', (event) => { if (event.target === $('token-detail-overlay')) showSheet(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') showSheet(false); });
  }

  bind();
  window.onEnterTokenDashboard = function onEnterTokenDashboard() {
    loadTokenDashboard();
  };
  window.TokenDashboard = { load: loadTokenDashboard };
})();
