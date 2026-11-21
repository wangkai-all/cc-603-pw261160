'use strict';

/**
 * 核心规则用例：覆盖题面要求的正常结果与异常结果。
 * 时间统一用一个基准点加分钟偏移，避免时区干扰。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeQualityEvents,
  compareRecovery,
  mergeImputedObservations,
  parseObservations,
  normalizeOptions,
  InputError,
  THRESHOLDS,
} = require('../lib/events');
const { buildDataset, buildImputationRows, at } = require('../lib/dataset');

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const min = (n) => T0 + n * 60 * 1000;

function obsAt(minutes, cod, extra = {}) {
  return { ts: min(minutes), cod, ...extra };
}

/** 生成从 start 到 end（含）每 step 分钟的序列。 */
function series(start, end, step, valueOf) {
  const rows = [];
  for (let m = start; m <= end; m += step) rows.push(obsAt(m, valueOf(m)));
  return rows;
}

const OPTS = { recoveryMinutes: 30, hysteresisRatio: 0.1, maxGapMinutes: 15 };

test('超限后连续恢复：事件在恢复确认时点封口，确认时点晚于首个恢复观测', () => {
  const rows = [
    ...series(0, 20, 5, (m) => 30), // 正常
    ...series(25, 55, 5, (m) => 62), // 超限 25..55
    ...series(60, 90, 5, () => 35), // 60 起恢复，90 覆盖满 30 分钟
    ...series(95, 120, 5, () => 30),
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.events.length, 1);
  assert.equal(run.openEvents.length, 0);

  const [event] = run.events;
  assert.equal(event.startedAt, min(25));
  assert.equal(event.recoveredAt, min(60), '首个恢复观测是 60 分钟处');
  assert.equal(event.confirmedAt, min(90), '连续 30 分钟恢复后确认');
  assert.equal(event.durationMinutes, 65, '时长从超限起点算到确认时点');
  assert.equal(event.recoverySpanMinutes, 35, '首个恢复观测相对超限起点的跨度');
  assert.equal(event.confirmLagMinutes, 30);
  assert.equal(event.status, 'resolved');
  assert.equal(event.peakValue, 62);
});

test('恢复观测不足连续时长时不封口，事件保持未恢复', () => {
  const rows = [
    ...series(0, 30, 5, () => 70),
    ...series(35, 50, 5, () => 30), // 只有 15 分钟恢复，不够 30 分钟
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.events.length, 0);
  assert.equal(run.openEvents.length, 1);
  assert.equal(run.openEvents[0].openReason, 'end-of-data');
  assert.equal(run.openEvents[0].recoveredAt, null);
  assert.equal(run.summary.meanDurationMinutes, null, '无已确认事件时均值必须为空而非 0');
});

test('短间隔抖动不拆段：超限中短暂回落再超限仍是同一段', () => {
  const rows = [
    ...series(0, 10, 5, () => 30),
    ...series(15, 30, 5, () => 64), // 超限
    obsAt(35, 46), // 落在迟滞区间（45~50），不算恢复
    obsAt(40, 48),
    ...series(45, 60, 5, () => 66), // 再次超限
    ...series(65, 95, 5, () => 34), // 65 起恢复，95 确认
    ...series(100, 120, 5, () => 30),
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.events.length, 1, '只应有一段');
  const [event] = run.events;
  assert.equal(event.startedAt, min(15));
  assert.equal(event.confirmedAt, min(95));
  assert.equal(event.readings.filter((r) => r.band === 'hysteresis').length, 2, '回落读数保留在段内');
});

test('恢复窗口被再次超限打断时重新计时，不提前封口', () => {
  const rows = [
    ...series(0, 20, 5, () => 60), // 超限
    ...series(25, 45, 5, () => 30), // 恢复 25..45，将满 25 分钟时再次超限
    ...series(50, 70, 5, () => 70), // 重新超限
    ...series(75, 105, 5, () => 30), // 75 起重新恢复，105 确认
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.events.length, 1);
  assert.equal(run.events[0].startedAt, min(0));
  assert.equal(run.events[0].recoveredAt, min(75), '恢复窗口按第二次恢复重新计时');
  assert.equal(run.events[0].confirmedAt, min(105));
});

test('迟滞区间内的回落不会开启恢复窗口', () => {
  const rows = [
    ...series(0, 20, 5, () => 60),
    obsAt(25, 47), // 迟滞区间，不做恢复观测
    obsAt(30, 46),
    obsAt(35, 49),
    ...series(40, 60, 5, () => 68),
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.events.length, 0);
  assert.equal(run.openEvents.length, 1, '落在迟滞区间的读数不足以恢复');
});

test('缺测截断：缺口两侧超限会产出未恢复样本和可补录候选', () => {
  const rows = [
    ...series(0, 20, 5, () => 70), // 20 分钟处最后一条
    // 25..55 缺测
    ...series(60, 80, 5, () => 72),
    ...series(85, 115, 5, () => 30),
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.openEvents.length, 1, '缺测把第一段截断为未恢复');
  assert.equal(run.openEvents[0].openReason, 'gap');
  assert.equal(run.events.length, 1, '缺口后仍能正常封口第二段');
  assert.equal(run.gaps.length, 1);
  assert.equal(run.mergeCandidates.length, 1);
  assert.equal(run.mergeCandidates[0].from, min(20));
  assert.equal(run.mergeCandidates[0].to, min(60));
});

test('缺口一侧未超限时不是合并候选', () => {
  const rows = [
    ...series(0, 20, 5, () => 70),
    // 缺测
    ...series(60, 80, 5, () => 30), // 缺口后已经恢复
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.gaps.length, 1);
  assert.equal(run.mergeCandidates.length, 0, '缺口后不再超限，补录也合并不了');
});

test('补录后两段合并为一段，时长按首尾重算而不是沿用旧值', () => {
  const rows = [
    ...series(0, 20, 5, () => 70),
    // 25..55 缺测
    ...series(60, 80, 5, () => 72),
    ...series(85, 115, 5, () => 30),
  ];
  const before = computeQualityEvents(rows, OPTS);
  const oldDurations = before.events.map((e) => e.durationMinutes);
  assert.deepEqual(oldDurations, [55], '补录前缺口后的段单独计算为 55 分钟');

  const candidate = before.mergeCandidates[0];
  const imputed = buildImputationRows(candidate, THRESHOLDS.cod);
  assert.ok(imputed.length >= 1);

  const mergedRows = mergeImputedObservations(rows, imputed);
  const after = computeQualityEvents(mergedRows, OPTS);

  assert.equal(after.events.length, 1, '两段合并成一段');
  assert.equal(after.openEvents.length, 0);
  assert.equal(after.gaps.length, 0, '补录后缺口消失');
  assert.equal(after.mergeCandidates.length, 0);
  const [event] = after.events;
  assert.equal(event.startedAt, min(0));
  assert.equal(event.confirmedAt, min(115));
  assert.equal(event.durationMinutes, 115);
  assert.ok(!oldDurations.includes(event.durationMinutes), '合并时长不等于任何旧事件时长');
  assert.equal(event.hasBackfilledReadings, true);
  assert.ok(event.readings.some((r) => r.source === 'manual'));
});

test('补录值若仍低于阈值则不会合并，事件保持两段', () => {
  const rows = [
    ...series(0, 20, 5, () => 70),
    ...series(60, 80, 5, () => 72),
    ...series(85, 115, 5, () => 30),
  ];
  const before = computeQualityEvents(rows, OPTS);
  const candidate = before.mergeCandidates[0];
  const lowRows = buildImputationRows(candidate, THRESHOLDS.cod).map((row) => ({ ...row, cod: 30 }));
  const after = computeQualityEvents(mergeImputedObservations(rows, lowRows), OPTS);
  assert.equal(after.events.length, 2, '补录的恢复观测会把缺口后那段重新算起');
  assert.equal(after.gaps.length, 0, '缺口已被补齐');
});

test('治理前后对照：确认时点决定分桶，未恢复样本单列且不进均值', () => {
  const rows = [
    ...series(0, 20, 5, () => 30),
    ...series(25, 55, 5, () => 62),
    ...series(60, 90, 5, () => 35), // confirmedAt = 90，在治理时点 70 之后
    ...series(95, 145, 5, () => 30),
    ...series(150, 180, 5, () => 64), // 未恢复
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.events.length, 1);
  assert.equal(run.openEvents.length, 1);

  const splitAt = min(70);
  const byConfirmed = compareRecovery(run, { splitAt, windowMode: 'confirmed' });
  assert.equal(byConfirmed.beforeEvents.length, 0);
  assert.equal(byConfirmed.afterEvents.length, 1, '按确认时点归到治理后');
  assert.equal(byConfirmed.pendingEvents.length, 1);
  assert.equal(byConfirmed.pendingStats.count, 1);
  assert.equal(byConfirmed.afterStats.count, 1, '未恢复样本不计入治理后');
  assert.equal(byConfirmed.beforeStats.meanDurationMinutes, null);
  assert.equal(byConfirmed.deltaMinutes, null);
  assert.equal(byConfirmed.verdict, 'partial');

  const byObserved = compareRecovery(run, { splitAt, windowMode: 'observed' });
  assert.equal(byObserved.beforeEvents.length, 1, '按恢复观测 60 分钟归到治理前');
  assert.equal(byObserved.afterEvents.length, 0);
  assert.equal(byObserved.pendingEvents.length, 1);
});

test('治理前后对照：两侧都有已确认事件时给出均值与差值', () => {
  const beforeRun = computeQualityEvents([
    ...series(0, 20, 5, () => 60),
    ...series(25, 55, 5, () => 30), // 25 起恢复，55 确认 → 55 分钟
  ], OPTS);
  const afterRun = computeQualityEvents([
    ...series(200, 210, 5, () => 60),
    ...series(215, 245, 5, () => 30), // 215 起恢复，245 确认 → 45 分钟
  ], OPTS);

  const comparison = compareRecovery(
    {
      events: [...beforeRun.events, ...afterRun.events],
      openEvents: [],
    },
    { splitAt: min(100), windowMode: 'confirmed' },
  );

  assert.equal(comparison.beforeStats.count, 1);
  assert.equal(comparison.afterStats.count, 1);
  assert.equal(comparison.beforeStats.meanDurationMinutes, 55);
  assert.equal(comparison.afterStats.meanDurationMinutes, 45);
  assert.equal(comparison.deltaMinutes, -10);
  assert.equal(comparison.improvementPct, 18.2);
  assert.equal(comparison.verdict, 'comparable');
  assert.equal(comparison.pendingStats.count, 0);
});

test('多个指标各自独立分段，互不影响', () => {
  const rows = [];
  for (let m = 0; m <= 120; m += 5) {
    rows.push({
      ts: min(m),
      cod: m >= 20 && m <= 60 ? 70 : 30,
      ammonia: m >= 70 && m <= 100 ? 9 : 1,
    });
  }
  // COD: 20..60 超限，65..95 恢复，95 确认；氨氮: 70..100 超限，105 起恢复但不够 30 分钟
  const run = computeQualityEvents(rows, OPTS);
  const cod = run.events.filter((e) => e.metric === 'cod');
  const ammoniaOpen = run.openEvents.filter((e) => e.metric === 'ammonia');
  assert.equal(cod.length, 1);
  assert.equal(ammoniaOpen.length, 1);
  assert.equal(cod[0].metricLabel, 'COD');
  assert.equal(ammoniaOpen[0].metricLabel, '氨氮');
});

test('传感器报数与换水工单分离：工单不影响事件分段', () => {
  const ds = buildDataset();
  const withOrders = computeQualityEvents(ds.observations, OPTS);
  const withoutOrders = computeQualityEvents(
    ds.observations.map(({ ts, cod, ammonia, turbidity }) => ({ ts, cod, ammonia, turbidity })),
    OPTS,
  );
  assert.deepEqual(
    withOrders.events.map((e) => [e.startedAt, e.confirmedAt]),
    withoutOrders.events.map((e) => [e.startedAt, e.confirmedAt]),
  );
  // 工单 WO-1003 已完成，但最后一个事件仍未恢复
  assert.ok(withOrders.openEvents.some((e) => e.startedAt >= at(17 * 60 + 40)));
});

/* ------------------------------ 异常结果 ------------------------------ */

test('异常：观测透传非数字指标时报错', () => {
  assert.throws(
    () => computeQualityEvents([{ ts: min(0), cod: 'abc' }], OPTS),
    (error) => error instanceof InputError && /COD/.test(error.message),
  );
});

test('异常：缺少指标时报错', () => {
  assert.throws(
    () => computeQualityEvents([{ ts: min(0) }], OPTS),
    (error) => error instanceof InputError && /至少需要一个指标/.test(error.message),
  );
});

test('异常：时间无法解析时报错', () => {
  assert.throws(
    () => computeQualityEvents([{ ts: 'not-a-date', cod: 30 }], OPTS),
    (error) => error instanceof InputError && /时间无法解析/.test(error.message),
  );
});

test('异常：负值观测被拒绝', () => {
  assert.throws(
    () => computeQualityEvents([{ ts: min(0), cod: -5 }], OPTS),
    (error) => error instanceof InputError && /非负数/.test(error.message),
  );
});

test('异常：参数越界被拒绝', () => {
  assert.throws(() => normalizeOptions({ hysteresisRatio: 0.6 }), InputError);
  assert.throws(() => normalizeOptions({ hysteresisRatio: -0.1 }), InputError);
  assert.throws(() => normalizeOptions({ recoveryMinutes: 0 }), InputError);
  assert.throws(() => normalizeOptions({ maxGapMinutes: 0 }), InputError);
  assert.throws(() => normalizeOptions({ recoveryMinutes: 10, maxGapMinutes: 15 }), InputError);
});

test('异常：空观测集返回空结果，均值为空', () => {
  const run = computeQualityEvents([], OPTS);
  assert.equal(run.events.length, 0);
  assert.equal(run.openEvents.length, 0);
  assert.equal(run.summary.count, 0);
  assert.equal(run.summary.meanDurationMinutes, null);
  assert.equal(run.summary.medianDurationMinutes, null);
});

test('异常：对照参数非法时报错', () => {
  const run = computeQualityEvents([], OPTS);
  assert.throws(() => compareRecovery(run, { splitAt: 'nope' }), InputError);
  assert.throws(() => compareRecovery(run, { splitAt: min(0), windowMode: 'anything' }), InputError);
});

test('异常：重复时间戳保持稳定排序且不产生负时长', () => {
  const rows = [
    { ts: min(0), cod: 60 },
    { ts: min(0), cod: 62 },
    ...series(5, 35, 5, () => 30),
  ];
  const run = computeQualityEvents(rows, OPTS);
  assert.equal(run.events.length, 1);
  assert.ok(run.events[0].durationMinutes >= 0);
});

test('解析：中文指标名和 source 标记被接受', () => {
  const parsed = parseObservations([
    { ts: min(0), COD: 60, 氨氮: 6, source: 'manual' },
    { ts: '2026-01-01T00:05:00Z', cod: 30, ammonia: 1 },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].metrics.cod, 60);
  assert.equal(parsed[0].metrics.ammonia, 6);
  assert.equal(parsed[0].source, 'manual');
  assert.equal(parsed[1].source, 'sensor');
  assert.equal(parsed[0].ts, min(0));
});
