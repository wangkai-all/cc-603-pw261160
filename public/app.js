'use strict';

/* 前端：只做展示与调用 API，全部事件计算都在服务端完成。 */

const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  version: 0,
  busy: false,
  loaded: false,
};

const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return TIME_FMT.format(date).replace(/\//g, '-');
}

function fmtClock(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

const MINUS = '−';

function fmtMinutes(value, { signed = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (signed) {
    if (value === 0) return '0';
    return value > 0 ? `+${value}` : `${MINUS}${Math.abs(value)}`;
  }
  return String(value);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* 操作                                                                 */
/* ------------------------------------------------------------------ */

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）`);
  }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败（HTTP ${res.status}）`);
  }
  return payload;
}

function setBusy(busy, label) {
  state.busy = busy;
  for (const id of ['#btn-generate', '#btn-impute', '#btn-compare']) {
    $(id).disabled = busy;
  }
  if (label) $('#action-status').textContent = label;
}

function setError(message) {
  const banner = $('#error-banner');
  if (!message) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
}

function bumpEvidence() {
  state.version += 1;
  $('.results').dataset.evidenceVersion = String(state.version);
}

async function loadState() {
  const payload = await request('GET', '/api/state');
  adoptState(payload);
}

function adoptState(payload) {
  state.data = payload;
  // 首次加载用数据集默认治理时点；之后保留用户填写的值。
  if (!state.loaded && payload.dataset && payload.dataset.splitAtIso) {
    $('#split-at-input').value = payload.dataset.splitAtIso;
    state.loaded = true;
  }
  render();
}

function viewBody() {
  return {
    splitAt: $('#split-at-input').value.trim() || undefined,
    windowMode: $('#window-mode').value,
  };
}

async function onGenerate() {
  if (state.busy) return;
  setError(null);
  setBusy(true, '正在生成事件…');
  try {
    const payload = await request('POST', '/api/events/generate', viewBody());
    adoptState(payload);
    const g = payload.generated;
    $('#action-status').textContent =
      `已生成 ${g.observationCount} 条观测：${g.resolvedCount} 个已确认事件、${g.openCount} 个未恢复样本、${g.mergeCandidateCount} 个可补录缺口`;
  } catch (error) {
    setError(error.message);
    $('#action-status').textContent = '生成失败';
  } finally {
    setBusy(false);
  }
}

async function onImpute() {
  if (state.busy) return;
  setError(null);
  const candidate = state.data?.run?.mergeCandidates?.[0];
  if (!candidate) {
    setError('当前没有可由补录合并的缺测区间。先点「生成水质事件」重置数据。');
    $('#action-status').textContent = '没有可补录的缺口';
    return;
  }
  setBusy(true, '正在补录缺失观测…');
  try {
    const payload = await request('POST', '/api/impute', {
      ...viewBody(),
      candidate: { metric: candidate.metric, from: candidate.from, to: candidate.to },
    });
    adoptState(payload);
    const r = payload.result;
    const merged = r.mergedEvent;
    if (merged) {
      const segs = merged.previousSegments || [];
      const prev = segs.length
        ? `（补录前为 ${segs.map((e) => e.status === 'open' ? `未恢复 ${e.durationMinutes}` : `${e.durationMinutes}`).join(' 分钟 + ')} 分钟的两段，合并后按时长首尾重算）`
        : '';
      $('#action-status').textContent =
        `已补录 ${payload.imputations.at(-1).count} 条 COD 观测：两段合并为 ${merged.durationMinutes} 分钟的一段${prev}，已确认事件 ${r.before.resolvedCount} → ${r.after.resolvedCount}`;
    } else {
      $('#action-status').textContent =
        `已补录 ${payload.imputations.at(-1).count} 条观测，已确认事件 ${r.before.resolvedCount} → ${r.after.resolvedCount}`;
    }
  } catch (error) {
    setError(error.message);
    $('#action-status').textContent = '补录失败';
  } finally {
    setBusy(false);
  }
}

async function onCompare() {
  if (state.busy) return;
  setError(null);
  const { splitAt, windowMode } = viewBody();
  if (!splitAt) {
    setError('请填写治理时点');
    return;
  }
  setBusy(true, '正在对照恢复时长…');
  try {
    const payload = await request('POST', '/api/compare', { splitAt, windowMode });
    state.data.comparison = payload.comparison;
    renderCompare(payload.comparison);
    bumpEvidence();
    $('#split-at').textContent = fmtTime(payload.comparison.splitAtIso);
    renderChart(state.data);
    const { beforeStats, afterStats, pendingStats } = payload.comparison;
    $('#action-status').textContent =
      `对照完成：治理前 ${beforeStats.count} 个 / 均值 ${fmtMinutes(beforeStats.meanDurationMinutes)} 分钟，治理后 ${afterStats.count} 个 / 均值 ${fmtMinutes(afterStats.meanDurationMinutes)} 分钟，未恢复 ${pendingStats.count} 个已单列`;
  } catch (error) {
    setError(error.message);
    $('#action-status').textContent = '对照失败';
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                 */
/* ------------------------------------------------------------------ */

function render() {
  const data = state.data;
  if (!data) return;
  const run = data.run;
  const comparison = data.comparison;

  $('#dataset-name').textContent = data.dataset.name;
  $('#split-at').textContent = fmtTime(data.dataset.splitAtIso);
  $('#rule-meta').textContent =
    `迟滞 ${Math.round(run.options.hysteresisRatio * 100)}% · 连续 ${run.options.recoveryMinutes} 分钟 · 采样间隔 ${run.options.maxGapMinutes} 分钟`;

  $('#stat-resolved').textContent = String(run.summary.count);
  $('#stat-resolved-note').textContent =
    run.summary.count ? `中位 ${fmtMinutes(run.summary.medianDurationMinutes)} 分钟` : '事件数';
  $('#stat-open').textContent = String(run.summary.openCount);
  $('#stat-open-note').textContent = run.summary.openCount
    ? `已累计 ${fmtMinutes(run.summary.pendingElapsedMinutes)} 分钟`
    : '不计入均值';
  $('#stat-mean').textContent = fmtMinutes(run.summary.meanDurationMinutes);
  $('#stat-gaps').textContent = String(run.mergeCandidates.length);
  $('#stat-gaps-note').textContent = run.gaps.length
    ? `共 ${run.gaps.length} 处缺测，${run.mergeCandidates.length} 处可合并`
    : '两侧均超限才可合并';


  renderChart(data);
  renderEvents(run);
  renderOpen(run);
  renderGaps(run);
  renderOrders(data.workOrders);
  renderImputations(data.imputations);
  renderCompare(comparison);
  bumpEvidence();
}

function renderEvents(run) {
  const tbody = $('#events-table tbody');
  tbody.replaceChildren();
  for (const event of run.events) {
    tbody.append(el('tr', {}, [
      el('td', { text: event.metricLabel }),
      el('td', { text: fmtTime(event.startedAtIso) }),
      el('td', { text: fmtTime(event.recoveredAtIso) }),
      el('td', {}, [
        el('span', { text: fmtTime(event.confirmedAtIso) }),
        event.hasBackfilledReadings ? el('span', { class: 'chip chip-manual chip-spaced', text: '含补录' }) : null,
      ]),
      el('td', { class: 'num', text: fmtMinutes(event.durationMinutes) }),
      el('td', { class: 'num', text: String(event.peakValue) }),
      el('td', { class: 'num', text: String(event.sampleCount) }),
    ]));
  }
  $('#events-empty').hidden = run.events.length > 0;
}

function renderOpen(run) {
  const tbody = $('#open-table tbody');
  tbody.replaceChildren();
  for (const event of run.openEvents) {
    const reason = event.openReason === 'gap' ? '缺测截断，可补录' : '数据结束仍未恢复';
    tbody.append(el('tr', {}, [
      el('td', { text: event.metricLabel }),
      el('td', { text: fmtTime(event.startedAtIso) }),
      el('td', { text: fmtTime(event.lastSeenAtIso) }),
      el('td', { class: 'num', text: fmtMinutes(event.durationMinutes) }),
      el('td', {}, el('span', { class: 'chip chip-open', text: reason })),
    ]));
  }
  $('#open-empty').hidden = run.openEvents.length > 0;
}

function renderGaps(run) {
  const tbody = $('#gaps-table tbody');
  tbody.replaceChildren();
  for (const gap of run.gaps) {
    const candidate = run.mergeCandidates.some((c) =>
      c.metric === gap.metric && c.from === gap.from && c.to === gap.to);
    tbody.append(el('tr', {}, [
      el('td', { text: gap.metricLabel }),
      el('td', { text: `${fmtTime(gap.fromIso)} → ${fmtTime(gap.toIso)}` }),
      el('td', { class: 'num', text: fmtMinutes(gap.gapMinutes) }),
      el('td', { class: 'num', text: `${gap.previousValue} / ${gap.nextValue}` }),
      el('td', {}, candidate
        ? el('span', { class: 'chip chip-manual', text: '可补录合并' })
        : el('span', { class: 'chip', text: '不构成合并' })),
    ]));
  }
  $('#gaps-empty').hidden = run.gaps.length > 0;
}

function renderOrders(orders) {
  const list = $('#order-list');
  list.replaceChildren();
  for (const order of orders) {
    list.append(el('li', {}, [
      el('div', { class: 'order-head' }, [
        el('span', { class: 'order-id', text: order.id }),
        el('span', { class: 'order-time', text: `${fmtTime(order.createdAtIso)} → ${fmtTime(order.completedAtIso)}` }),
      ]),
      el('p', { class: 'order-note', text: order.note }),
    ]));
  }
}

function renderImputations(imputations) {
  const panel = $('#impute-panel');
  panel.hidden = imputations.length === 0;
  const tbody = $('#impute-table tbody');
  tbody.replaceChildren();
  for (const item of imputations) {
    tbody.append(el('tr', {}, [
      el('td', { text: item.id }),
      el('td', { text: item.metric.toUpperCase() }),
      el('td', { text: `${fmtTime(item.fromIso)} → ${fmtTime(item.toIso)}` }),
      el('td', { class: 'num', text: String(item.count) }),
    ]));
  }
  $('#impute-sub').textContent = imputations.length
    ? `共 ${imputations.length} 次补录，均按重新计算后的结果呈现；合并段不沿用旧事件时长。`
    : '—';
}

function renderCompare(comparison) {
  if (!comparison) return;
  const { beforeStats, afterStats, pendingStats, windowMode, splitAtIso } = comparison;

  $('#compare-sub').textContent = windowMode === 'confirmed'
    ? `按恢复确认时点归并（治理时点 ${fmtTime(splitAtIso)}）；未恢复样本不计入两侧均值。`
    : `按首个恢复观测归并（治理时点 ${fmtTime(splitAtIso)}）；未恢复样本不计入两侧均值。`;

  $('#compare-before-mean').textContent = fmtMinutes(beforeStats.meanDurationMinutes);
  $('#compare-before-note').textContent = `事件数 ${beforeStats.count}`;
  $('#compare-after-mean').textContent = fmtMinutes(afterStats.meanDurationMinutes);
  $('#compare-after-note').textContent = `事件数 ${afterStats.count}`;
  $('#compare-delta').textContent = fmtMinutes(comparison.deltaMinutes, { signed: true });
  $('#compare-delta').className = 'compare-value ' +
    (comparison.deltaMinutes === null ? '' : comparison.deltaMinutes < 0 ? 'delta-down' : comparison.deltaMinutes > 0 ? 'delta-up' : '');
  $('#compare-delta-note').textContent = comparison.improvementPct === null
    ? '治理后减治理前'
    : `变化 ${fmtMinutes(comparison.improvementPct, { signed: true })}%`;
  $('#compare-pending').textContent = String(pendingStats.count);
  $('#compare-pending-note').textContent = pendingStats.count
    ? `已累计 ${fmtMinutes(pendingStats.elapsedMinutesTotal)} 分钟，单列`
    : '无未恢复样本';

  const verdict = $('#compare-verdict');
  if (comparison.verdict === 'partial') {
    verdict.textContent = '部分可比：存在未恢复样本';
    verdict.className = 'verdict partial';
  } else {
    verdict.textContent = '可比：全部样本已确认恢复';
    verdict.className = 'verdict';
  }

  const tbody = $('#compare-table tbody');
  tbody.replaceChildren();
  const rows = [
    ...comparison.beforeEvents.map((e) => ({ ...e, bucketLabel: '治理前' })),
    ...comparison.afterEvents.map((e) => ({ ...e, bucketLabel: '治理后' })),
    ...comparison.pendingEvents.map((e) => ({ ...e, bucketLabel: '未恢复（单列）', confirmedAtIso: null })),
  ];
  for (const event of rows) {
    tbody.append(el('tr', {}, [
      el('td', {}, el('span', {
        class: `chip ${event.bucket === 'pending' ? 'chip-open' : event.bucket === 'after' ? 'chip-good' : ''}`,
        text: event.bucketLabel,
      })),
      el('td', { text: event.metricLabel }),
      el('td', { text: fmtTime(event.startedAtIso) }),
      el('td', { text: event.confirmedAtIso ? fmtTime(event.confirmedAtIso) : '未确认' }),
      el('td', { class: 'num', text: event.status === 'open' ? `≥ ${fmtMinutes(event.durationMinutes)}` : fmtMinutes(event.durationMinutes) }),
      el('td', {}, event.hasBackfilledReadings ? el('span', { class: 'chip chip-manual', text: '含补录' }) : '—'),
    ]));
  }

  $('#compare-foot').textContent = windowMode === 'confirmed'
    ? '确认时点 = 连续恢复窗口结束的那次观测；它总是晚于首个恢复观测，因此跨治理时点的事件会按确认时点归入治理后。'
    : '按首个恢复观测归并时，确认时点仍保留在明细里交给分析端，但分桶使用恢复观测时点。';
}

/* ------------------------------------------------------------------ */
/* 图表                                                                 */
/* ------------------------------------------------------------------ */

const CHART = { width: 900, height: 320, left: 52, right: 24, top: 24, bottom: 40 };

function renderChart(data) {
  const svg = $('#chart');
  const old = svg.querySelector('g.plot');
  if (old) old.remove();
  svg.querySelectorAll('.hover-line, .hover-dot, .tooltip-anchor').forEach((n) => n.remove());

  const run = data.run;
  const usable = data.observations.filter((obs) => obs.cod !== undefined && obs.cod !== null);
  if (usable.length === 0) return;

  const splitIso = data.comparison?.splitAtIso || data.dataset.splitAtIso;
  const splitMs = new Date(splitIso).getTime();
  const tMin = Math.min(usable[0].ts, splitMs);
  const tMax = Math.max(usable[usable.length - 1].ts, splitMs);
  const padMs = 5 * 60 * 1000;
  const x0 = tMin - padMs;
  const x1 = tMax + padMs;
  const allValues = usable.map((o) => o.cod);
  const yMax = Math.max(...allValues, run.thresholds.cod) * 1.12;

  const { width, height, left, right, top, bottom } = CHART;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const sx = (ts) => left + ((ts - x0) / (x1 - x0)) * plotW;
  const sy = (v) => top + plotH - (v / yMax) * plotH;

  const plot = svgEl('g', { class: 'plot' });

  // y 轴网格与刻度
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i += 1) {
    const value = (yMax / yTicks) * i;
    const y = sy(value);
    plot.append(svgEl('line', { class: 'grid-line', x1: left, y1: y, x2: left + plotW, y2: y }));
    const label = svgEl('text', { class: 'tick-label', x: left - 8, y: y + 4, 'text-anchor': 'end' });
    label.textContent = String(Math.round(value));
    plot.append(label);
  }
  plot.append(svgEl('line', { class: 'axis-line', x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH }));

  // x 轴刻度：每小时
  const hourMs = 60 * 60 * 1000;
  const startHour = Math.ceil(x0 / hourMs) * hourMs;
  for (let ts = startHour; ts <= x1; ts += hourMs) {
    const x = sx(ts);
    const label = svgEl('text', { class: 'tick-label', x, y: top + plotH + 20, 'text-anchor': 'middle' });
    label.textContent = fmtClock(ts);
    plot.append(label);
  }

  // 缺测区间
  for (const gap of run.gaps) {
    if (gap.metric !== 'cod') continue;
    const gx = sx(gap.from);
    const gw = Math.max(2, sx(gap.to) - gx);
    plot.append(svgEl('rect', {
      class: 'gap-band', x: gx, y: top, width: gw, height: plotH,
    }));
    const label = svgEl('text', { class: 'gap-label', x: gx + gw / 2, y: top + 12, 'text-anchor': 'middle' });
    label.textContent = '缺测';
    plot.append(label);
  }

  // 事件带：已确认为绿，未恢复为红
  for (const event of run.events) {
    if (event.metric !== 'cod') continue;
    const bx = sx(event.startedAt);
    const bw = Math.max(2, sx(event.confirmedAt) - bx);
    plot.append(svgEl('rect', { class: 'event-band good', x: bx, y: top, width: bw, height: plotH }));
  }
  for (const event of run.openEvents) {
    if (event.metric !== 'cod') continue;
    const bx = sx(event.startedAt);
    const bw = Math.max(2, sx(event.lastSeenAt) - bx);
    plot.append(svgEl('rect', { class: 'event-band open', x: bx, y: top, width: bw, height: plotH }));
  }

  // 阈值线
  const ty = sy(run.thresholds.cod);
  plot.append(svgEl('line', { class: 'threshold-line', x1: left, y1: ty, x2: left + plotW, y2: ty }));
  const tLabel = svgEl('text', { class: 'threshold-label', x: left + plotW - 4, y: ty - 6, 'text-anchor': 'end' });
  tLabel.textContent = `阈值 ${run.thresholds.cod} mg/L`;
  plot.append(tLabel);

  // 治理时点
  const splitX = sx(splitMs);
  plot.append(svgEl('line', { class: 'split-line', x1: splitX, y1: top - 8, x2: splitX, y2: top + plotH }));
  const splitLabel = svgEl('text', { class: 'split-label', x: splitX + 4, y: top - 2 });
  splitLabel.textContent = '治理时点';
  plot.append(splitLabel);

  // 观测折线（跨缺口断开）
  const maxGapMs = run.options.maxGapMinutes * 60 * 1000;
  let segment = [];
  const flush = () => {
    if (segment.length > 1) {
      plot.append(svgEl('polyline', {
        class: 'series-line',
        points: segment.map((o) => `${sx(o.ts)},${sy(o.cod)}`).join(' '),
      }));
    }
    segment = [];
  };
  for (const obs of usable) {
    if (segment.length && obs.ts - segment[segment.length - 1].ts > maxGapMs) flush();
    segment.push(obs);
  }
  flush();

  // 观测点：普通实心、补录空心；点太密时减少普通点的显示密度，补录点始终显示。
  const densityStep = Math.max(1, Math.ceil(usable.length / 90));
  usable.forEach((obs, index) => {
    const isManual = obs.source === 'manual';
    if (!isManual && index % densityStep !== 0) return;
    plot.append(svgEl('circle', {
      class: `series-dot${isManual ? ' manual' : ''}`,
      cx: sx(obs.ts), cy: sy(obs.cod), r: isManual ? 3.6 : 3.2,
    }));
  });

  // 悬停层
  const hoverLine = svgEl('line', { class: 'hover-line', x1: 0, y1: top, x2: 0, y2: top + plotH, stroke: 'var(--text-muted)', 'stroke-width': 1, opacity: 0 });
  const hoverDot = svgEl('circle', { class: 'hover-dot', r: 4, cx: 0, cy: 0, opacity: 0 });
  const hit = svgEl('rect', { class: 'hover-target', x: left, y: top, width: plotW, height: plotH });
  plot.append(hoverLine, hoverDot, hit);

  svg.append(plot);

  const tooltip = ensureTooltip(svg.parentElement);
  hit.addEventListener('mousemove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const px = (event.clientX - rect.left) * scaleX;
    let nearest = usable[0];
    let best = Infinity;
    for (const obs of usable) {
      const d = Math.abs(sx(obs.ts) - px);
      if (d < best) { best = d; nearest = obs; }
    }
    const x = sx(nearest.ts);
    hoverLine.setAttribute('x1', x);
    hoverLine.setAttribute('x2', x);
    hoverLine.setAttribute('opacity', '0.6');
    hoverDot.setAttribute('cx', x);
    hoverDot.setAttribute('cy', sy(nearest.cod));
    hoverDot.setAttribute('opacity', '1');

    const owner = run.events.find((e) => e.metric === 'cod' && nearest.ts >= e.startedAt && nearest.ts <= e.confirmedAt)
      || run.openEvents.find((e) => e.metric === 'cod' && nearest.ts >= e.startedAt && nearest.ts <= e.lastSeenAt);
    tooltip.replaceChildren(
      el('dl', {}, [
        el('dt', { text: '时间' }), el('dd', { text: fmtTime(nearest.tsIso) }),
        el('dt', { text: 'COD' }), el('dd', { text: `${nearest.cod} mg/L` }),
        el('dt', { text: '来源' }), el('dd', { text: nearest.source === 'manual' ? '补录' : '传感器' }),
        el('dt', { text: '状态' }), el('dd', { text: owner ? (owner.status === 'open' ? '未恢复事件内' : '已确认事件内') : '正常' }),
      ]),
    );
    tooltip.classList.add('visible');
    const pxPerUnit = rect.width / width;
    tooltip.style.left = `${x * pxPerUnit}px`;
    tooltip.style.top = `${sy(nearest.cod) * (rect.height / height) - 8}px`;
  });
  hit.addEventListener('mouseleave', () => {
    hoverLine.setAttribute('opacity', '0');
    hoverDot.setAttribute('opacity', '0');
    tooltip.classList.remove('visible');
  });
}

function ensureTooltip(container) {
  if (!container) return el('div', { class: 'chart-tooltip' });
  let tooltip = container.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = el('div', { class: 'chart-tooltip', role: 'presentation' });
    container.append(tooltip);
  }
  return tooltip;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

// 先绑定按钮，再拉初始状态；初始拉取失败时操作按钮仍可用。
for (const [id, handler] of [
  ['#btn-generate', onGenerate],
  ['#btn-impute', onImpute],
  ['#btn-compare', onCompare],
]) {
  $(id).addEventListener('click', handler);
}

loadState().then(() => {
  $('#action-status').textContent = '已加载本地造数，可直接操作或先点「生成水质事件」重置';
}).catch((error) => {
  setError(`初始化失败：${error.message}`);
  $('#action-status').textContent = '初始化失败，可点「生成水质事件」重建数据';
});
