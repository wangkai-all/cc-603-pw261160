'use strict';

/**
 * 事件时间线计算核心。
 *
 * 业务规则：
 * 1. 传感器报数（观测）与换水工单是两条独立的流；工单不会截断或开启事件段。
 * 2. 指标超过阈值即进入超限；必须连续覆盖 recoveryMinutes 的恢复观测，
 *    事件才在"确认时点"封口。恢复观测起点记作 recoveredAt，确认观测记作 confirmedAt。
 * 3. 超限期间短暂回落（迟滞区间内或单次低于恢复线）不拆段，恢复窗口会重新计时。
 * 4. 同一指标相邻观测间隔超过 maxGapMinutes 视为缺测：正在发生的事件被截断为
 *    "未确认恢复"，如果缺口两侧都仍超限，则成为一个可补录的合并候选。
 * 5. 补录后重新计算全序列；两段合并成一段时，时长按合并后的首尾重新计算，
 *    绝不沿用旧事件的平均时长。
 * 6. 仍未确认恢复的样本只出现在 openEvents，前后对照时单列，不进入均值。
 */

const THRESHOLDS = Object.freeze({
  cod: 50, // mg/L
  ammonia: 5, // mg/L
  turbidity: 20, // NTU
});

const METRIC_KEYS = Object.freeze(Object.keys(THRESHOLDS));
const METRIC_LABELS = Object.freeze({
  cod: 'COD',
  ammonia: '氨氮',
  turbidity: '浊度',
});

const SETTINGS = Object.freeze({
  // 迟滞区间：回落到阈值 * (1 - ratio) 以下才算恢复观测。
  hysteresisRatio: 0.1,
  // 连续恢复时长：恢复观测需连续覆盖这么久才确认封口。
  recoveryMinutes: 30,
  // 同一指标的相邻观测超过这个间隔视为缺测。
  maxGapMinutes: 15,
  maxHysteresisRatio: 0.5,
});

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.statusCode = 400;
  }
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function toIso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ */
/* 参数与观测解析                                                       */
/* ------------------------------------------------------------------ */

function normalizeOptions(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new InputError('options 需为对象');
  }
  const hysteresisRatio = options.hysteresisRatio === undefined
    ? SETTINGS.hysteresisRatio
    : Number(options.hysteresisRatio);
  const recoveryMinutes = options.recoveryMinutes === undefined
    ? SETTINGS.recoveryMinutes
    : Number(options.recoveryMinutes);
  const maxGapMinutes = options.maxGapMinutes === undefined
    ? SETTINGS.maxGapMinutes
    : Number(options.maxGapMinutes);

  if (!Number.isFinite(hysteresisRatio) || hysteresisRatio < 0 || hysteresisRatio >= SETTINGS.maxHysteresisRatio) {
    throw new InputError(`迟滞比例需在 [0, ${SETTINGS.maxHysteresisRatio}) 之间`);
  }
  if (!Number.isFinite(recoveryMinutes) || recoveryMinutes <= 0) {
    throw new InputError('恢复连续时长需大于 0 分钟');
  }
  if (!Number.isFinite(maxGapMinutes) || maxGapMinutes <= 0) {
    throw new InputError('最大采样间隔需大于 0 分钟');
  }
  if (maxGapMinutes >= recoveryMinutes) {
    // 否则单次恢复观测就可能覆盖整个确认窗口，连续时长失去意义。
    throw new InputError('最大采样间隔必须小于恢复连续时长');
  }
  return { hysteresisRatio, recoveryMinutes, maxGapMinutes };
}

function toFiniteNumber(raw, field) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new InputError(`${field} 需为非负数`);
  }
  return n;
}

function parseTimestamp(raw, field) {
  if (raw === null || raw === undefined || raw === '') {
    throw new InputError(`${field}缺少时间`);
  }
  const ms = raw instanceof Date
    ? raw.getTime()
    : typeof raw === 'number'
      ? raw
      : new Date(String(raw)).getTime();
  if (!Number.isFinite(ms)) {
    throw new InputError(`${field}时间无法解析`);
  }
  return ms;
}

/**
 * 解析并排序观测。每行必须有 ts（ISO 时间或毫秒时间戳）与至少一个指标。
 * 设备报数与人工补录都走这里，source 只做来源标记，不影响事件分段规则。
 */
function parseObservations(rawRows, { source = 'sensor' } = {}) {
  if (!Array.isArray(rawRows)) {
    throw new InputError('observations 需为数组');
  }
  const rows = rawRows.map((row, idx) => {
    if (!row || typeof row !== 'object') {
      throw new InputError(`第 ${idx + 1} 条观测格式不合法`);
    }
    const ts = parseTimestamp(row.ts ?? row.time ?? row.observedAt, `第 ${idx + 1} 条观测`);
    const metrics = {};
    let hasMetric = false;
    for (const key of METRIC_KEYS) {
      const raw = row[key] ?? row[METRIC_LABELS[key]];
      const value = toFiniteNumber(raw, `${METRIC_LABELS[key]}（第 ${idx + 1} 条观测）`);
      if (value !== null) {
        metrics[key] = value;
        hasMetric = true;
      }
    }
    if (!hasMetric) {
      throw new InputError(`第 ${idx + 1} 条观测至少需要一个指标`);
    }
    let rowSource = row.source === undefined ? source : String(row.source).trim();
    if (!rowSource || rowSource.length > 32) {
      throw new InputError(`第 ${idx + 1} 条观测的来源标记不合法`);
    }
    return { ts, metrics, source: rowSource, note: row.note ? String(row.note) : undefined };
  });
  rows.sort((a, b) => a.ts - b.ts || a.source.localeCompare(b.source));
  return rows;
}

/* ------------------------------------------------------------------ */
/* 单指标分段                                                           */
/* ------------------------------------------------------------------ */

function makeResolved(metric, current, { recoveredAt, confirmedAt }) {
  const readings = current.readings;
  return {
    metric,
    threshold: current.threshold,
    status: 'resolved',
    startedAt: current.startedAt,
    startValue: current.startValue,
    recoveredAt,
    confirmedAt,
    confirmLagMinutes: round1((confirmedAt - recoveredAt) / 60000),
    lastSeenAt: confirmedAt,
    // 事件从超限起点一直持续到恢复被确认，时长按确认时点计算；
    // recoveredAt 是首个恢复观测，仅作为证据暴露给分析端。
    durationMinutes: round1((confirmedAt - current.startedAt) / 60000),
    recoverySpanMinutes: round1((recoveredAt - current.startedAt) / 60000),
    peakValue: Math.max(...readings.map((r) => r.value)),
    readings,
  };
}

function makeOpen(metric, current, lastSeenAt, reason) {
  const readings = current.readings;
  return {
    metric,
    threshold: current.threshold,
    status: 'open',
    startedAt: current.startedAt,
    startValue: current.startValue,
    recoveredAt: null,
    confirmedAt: null,
    confirmLagMinutes: null,
    lastSeenAt,
    openReason: reason,
    durationMinutes: round1((lastSeenAt - current.startedAt) / 60000),
    peakValue: Math.max(...readings.map((r) => r.value)),
    readings,
  };
}

/**
 * 对单个指标做事件分段。返回超限段、因缺测被截断的数据缺口，以及
 * "两侧都超限、可通过补录合并"的候选。
 */
function segmentMetric(metric, observations, options) {
  const threshold = THRESHOLDS[metric];
  const recoveryLine = threshold * (1 - options.hysteresisRatio);
  const maxGapMs = options.maxGapMinutes * 60000;
  const recoveryMs = options.recoveryMinutes * 60000;

  const events = [];
  const openEvents = [];
  const gaps = [];
  const mergeCandidates = [];

  let current = null;
  let recoveryAnchor = null;
  let previous = null;

  const startEvent = (obs) => ({
    startedAt: obs.ts,
    startValue: obs.metrics[metric],
    readings: [{ ts: obs.ts, value: obs.metrics[metric], source: obs.source }],
  });

  for (const obs of observations) {
    const value = obs.metrics[metric];

    if (previous !== null && obs.ts - previous.ts > maxGapMs) {
      const previousValue = previous.metrics[metric];
      const gap = {
        metric,
        from: previous.ts,
        to: obs.ts,
        gapMinutes: round1((obs.ts - previous.ts) / 60000),
        previousValue,
        nextValue: value,
      };
      // 缺测本身总是记录；它是否截断事件、是否可补录合并另算。
      gaps.push(gap);
      if (current !== null) {
        openEvents.push(makeOpen(metric, current, previous.ts, 'gap'));
        // 缺口两侧都仍超限，补录后大概率能接成一段，才作为合并候选。
        if (previousValue > threshold && value > threshold) {
          mergeCandidates.push({ ...gap });
        }
        current = null;
        recoveryAnchor = null;
      }
    }

    if (current === null) {
      if (value > threshold) {
        current = startEvent(obs);
        recoveryAnchor = null;
      }
    } else if (value > threshold) {
      current.readings.push({ ts: obs.ts, value, source: obs.source });
      // 超限重现：恢复窗口作废。迟滞区间内短暂回落不拆段。
      recoveryAnchor = null;
    } else if (value <= recoveryLine) {
      if (recoveryAnchor === null) recoveryAnchor = obs.ts;
      if (obs.ts - recoveryAnchor >= recoveryMs) {
        events.push(makeResolved(metric, current, { recoveredAt: recoveryAnchor, confirmedAt: obs.ts }));
        current = null;
        recoveryAnchor = null;
      }
    } else {
      // 落在迟滞区间（恢复线以上、阈值以下）：不算恢复，也不另起一段。
      current.readings.push({ ts: obs.ts, value, source: obs.source, band: 'hysteresis' });
      recoveryAnchor = null;
    }

    previous = obs;
  }

  if (current !== null) {
    openEvents.push(makeOpen(metric, current, previous.ts, 'end-of-data'));
  }

  return { events, openEvents, gaps, mergeCandidates };
}

/* ------------------------------------------------------------------ */
/* 对外计算入口                                                         */
/* ------------------------------------------------------------------ */

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round1((sorted[mid - 1] + sorted[mid]) / 2);
}

function summarize(events) {
  const durations = events.map((e) => e.durationMinutes);
  return {
    count: events.length,
    meanDurationMinutes: durations.length ? round1(durations.reduce((s, n) => s + n, 0) / durations.length) : null,
    medianDurationMinutes: median(durations),
    minDurationMinutes: durations.length ? Math.min(...durations) : null,
    maxDurationMinutes: durations.length ? Math.max(...durations) : null,
    totalDurationMinutes: round1(durations.reduce((s, n) => s + n, 0)),
  };
}

function computeQualityEvents(rawRows, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const observations = parseObservations(rawRows);

  const events = [];
  const openEvents = [];
  const gaps = [];
  const mergeCandidates = [];

  for (const metric of METRIC_KEYS) {
    // 只把带有该指标的观测当作该指标的证据，避免其他指标的报数被误读成缺测。
    const relevant = observations.filter((obs) => obs.metrics[metric] !== undefined);
    const result = segmentMetric(metric, relevant, options);

    for (const event of result.events) {
      events.push(decorate(event));
    }
    for (const event of result.openEvents) {
      openEvents.push(decorate(event));
    }
    for (const gap of result.gaps) gaps.push(decorate(gap));
    for (const candidate of result.mergeCandidates) mergeCandidates.push(decorate(candidate));
  }

  events.sort((a, b) => a.startedAt - b.startedAt || a.metric.localeCompare(b.metric));
  openEvents.sort((a, b) => a.startedAt - b.startedAt || a.metric.localeCompare(b.metric));
  gaps.sort((a, b) => a.from - b.from);
  mergeCandidates.sort((a, b) => a.from - b.from);

  const summary = summarize(events);
  summary.openCount = openEvents.length;
  summary.pendingElapsedMinutes = round1(
    openEvents.reduce((sum, event) => sum + event.durationMinutes, 0),
  );

  return {
    options,
    thresholds: THRESHOLDS,
    metricLabels: METRIC_LABELS,
    observationCount: observations.length,
    events,
    openEvents,
    summary,
    gaps,
    mergeCandidates,
    observations: observations.map((obs) => ({
      ts: obs.ts,
      tsIso: toIso(obs.ts),
      source: obs.source,
      ...obs.metrics,
      ...(obs.note ? { note: obs.note } : {}),
    })),
  };
}

function decorate(item) {
  if (!item) return item;
  const out = { ...item };
  if (out.metric) {
    out.metricLabel = METRIC_LABELS[out.metric];
    out.threshold = THRESHOLDS[out.metric];
  }
  for (const [msKey, isoKey] of [
    ['startedAt', 'startedAtIso'],
    ['recoveredAt', 'recoveredAtIso'],
    ['confirmedAt', 'confirmedAtIso'],
    ['lastSeenAt', 'lastSeenAtIso'],
    ['from', 'fromIso'],
    ['to', 'toIso'],
  ]) {
    if (out[msKey] !== undefined) out[isoKey] = toIso(out[msKey]);
  }
  if (out.readings) {
    out.sampleCount = out.readings.length;
    out.hasBackfilledReadings = out.readings.some((r) => r.source === 'manual');
    out.readings = out.readings.map((r) => ({ ...r, tsIso: toIso(r.ts) }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 补录合并                                                             */
/* ------------------------------------------------------------------ */

/**
 * 把补录行并入现有观测。补录行与传感器行同构，source 默认 manual。
 * 是否合并成同一段由重新计算的连续性与恢复规则决定，不在这里硬拼。
 */
function mergeImputedObservations(rows, imputed) {
  const base = parseObservations(rows);
  const extra = parseObservations(imputed, { source: 'manual' });
  return [...base, ...extra]
    .sort((a, b) => a.ts - b.ts || a.source.localeCompare(b.source))
    .map((obs) => ({
      ts: obs.ts,
      ...obs.metrics,
      source: obs.source,
      ...(obs.note ? { note: obs.note } : {}),
    }));
}

/* ------------------------------------------------------------------ */
/* 治理前后对照                                                         */
/* ------------------------------------------------------------------ */

/**
 * 按归并时点把已恢复事件分成治理前 / 治理后，未确认恢复的事件单列。
 * - windowMode=confirmed：使用确认时点 confirmedAt（分析端默认口径）；
 * - windowMode=observed：使用恢复观测时点 recoveredAt。
 * 未确认恢复的事件在两种口径下都不参与均值。
 */
function compareRecovery(run, { splitAt, windowMode = 'confirmed' } = {}) {
  if (!run || !Array.isArray(run.events) || !Array.isArray(run.openEvents)) {
    throw new InputError('对照需要有效的事件计算结果');
  }
  if (!['confirmed', 'observed'].includes(windowMode)) {
    throw new InputError('windowMode 仅支持 confirmed 或 observed');
  }
  const splitMs = parseTimestamp(splitAt, '治理时点');
  const keyOf = windowMode === 'confirmed'
    ? (event) => event.confirmedAt
    : (event) => event.recoveredAt;

  const beforeEvents = [];
  const afterEvents = [];

  for (const event of run.events) {
    const key = keyOf(event);
    if (key === null || key === undefined) {
      throw new InputError('已恢复事件缺少归并时点');
    }
    const record = { ...event, bucket: key >= splitMs ? 'after' : 'before' };
    (key >= splitMs ? afterEvents : beforeEvents).push(record);
  }

  const beforeStats = summarize(beforeEvents);
  const afterStats = summarize(afterEvents);
  const pendingEvents = run.openEvents.map((event) => ({ ...event, bucket: 'pending' }));
  const pendingStats = {
    count: pendingEvents.length,
    elapsedMinutesTotal: round1(pendingEvents.reduce((s, e) => s + e.durationMinutes, 0)),
    note: '未确认恢复样本单列，不参与治理前后均值',
  };

  const deltaMinutes = beforeStats.count > 0 && afterStats.count > 0
    ? round1(afterStats.meanDurationMinutes - beforeStats.meanDurationMinutes)
    : null;
  const improvementPct = beforeStats.count > 0 && afterStats.count > 0 && beforeStats.meanDurationMinutes > 0
    ? round1(((beforeStats.meanDurationMinutes - afterStats.meanDurationMinutes) / beforeStats.meanDurationMinutes) * 100)
    : null;

  return {
    windowMode,
    splitAt: splitMs,
    splitAtIso: toIso(splitMs),
    beforeEvents,
    afterEvents,
    pendingEvents,
    beforeStats,
    afterStats,
    pendingStats,
    deltaMinutes,
    improvementPct,
    verdict: pendingStats.count === 0 ? 'comparable' : 'partial',
  };
}

module.exports = {
  THRESHOLDS,
  METRIC_KEYS,
  METRIC_LABELS,
  SETTINGS,
  InputError,
  normalizeOptions,
  parseObservations,
  segmentMetric,
  mergeImputedObservations,
  computeQualityEvents,
  compareRecovery,
  summarize,
  round1,
};
