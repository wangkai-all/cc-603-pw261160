'use strict';

/**
 * 本地造数：一条 5 分钟采样的水质时间线，覆盖
 * - 正常超限后连续恢复；
 * - 超限期间短暂回落（迟滞区间）；
 * - 缺测导致事件被截断，补录后可合并；
 * - 数据结束时仍未恢复的样本；
 * - 独立的换水工单（工单完成不代表指标恢复）。
 */

const DAY = Date.UTC(2026, 10, 1, 0, 0, 0); // 2026-11-01T00:00:00Z
const STEP_MS = 5 * 60 * 1000;

function at(minutes) {
  return DAY + minutes * 60 * 1000;
}

function tickMinutes(startMin, endMin) {
  const out = [];
  for (let m = startMin; m <= endMin; m += 5) out.push(m);
  return out;
}

function baselineCod(minute) {
  return 30 + (((minute / 5) * 7) % 13); // 30..42，低于恢复线 45
}

function baselineAmmonia(minute) {
  return Math.round((0.6 + (((minute / 5) * 11) % 13) / 10) * 10) / 10; // 0.6..1.8
}

function baselineTurbidity(minute) {
  return 3 + (((minute / 5) * 5) % 7); // 3..9
}

function overValue(minute, phase) {
  return 56 + (((minute / 5 + phase) * 3) % 11); // 56..66
}

function recoveryValue(minute) {
  return 34 + (((minute / 5) * 3) % 9); // 34..42，<= 45 恢复线
}

const COD_RULES = [
  // 治理前事件 E1：08:00 超限，08:45 起连续恢复，09:15 确认。
  { from: 8 * 60, to: 8 * 60 + 40, fn: (m) => overValue(m, 1) },
  { from: 8 * 60 + 45, to: 9 * 60 + 15, fn: recoveryValue },
  // 治理前事件 E2：10:00 超限，10:25 回落进迟滞区间，10:30 再次超限，不拆段；
  // 10:40 起连续恢复，11:10 确认（跨过治理时点但按确认时点归到治理后）。
  { from: 10 * 60, to: 10 * 60 + 35, fn: (m) => (m === 10 * 60 + 25 ? 48 : overValue(m, 2)) },
  { from: 10 * 60 + 40, to: 11 * 60 + 10, fn: recoveryValue },
  // 缺测断点：12:20-12:30 超限，12:35-12:55 无 COD 观测，13:00-13:05 再次超限，
  // 13:10 起恢复。补录两点之间的数据后两段合并为一段。
  { from: 12 * 60 + 20, to: 12 * 60 + 30, fn: (m) => overValue(m, 3) },
  { from: 13 * 60, to: 13 * 60 + 5, fn: (m) => overValue(m, 4) },
  { from: 13 * 60 + 10, to: 13 * 60 + 40, fn: recoveryValue },
  // 治理后事件 E4：15:00 超限，15:15 起恢复，15:45 确认。
  { from: 15 * 60, to: 15 * 60 + 10, fn: (m) => overValue(m, 5) },
  { from: 15 * 60 + 15, to: 15 * 60 + 45, fn: recoveryValue },
  // 未恢复样本 E5：17:40 起持续超限到数据结束，换水工单完成也无法封口。
  { from: 17 * 60 + 40, to: 18 * 60 + 30, fn: (m) => 68 + (((m / 5) * 3) % 9) },
];

const COD_GAP = { from: 12 * 60 + 30, to: 13 * 60 }; // 上一行与下一行之间

function codAt(minute) {
  if (minute > COD_GAP.from && minute < COD_GAP.to) return null; // 缺测
  for (const rule of COD_RULES) {
    if (minute >= rule.from && minute <= rule.to) return rule.fn(minute);
  }
  return baselineCod(minute);
}

function buildObservations() {
  const rows = [];
  for (const minute of tickMinutes(7 * 60, 18 * 60 + 30)) {
    const row = {
      ts: at(minute),
      ammonia: baselineAmmonia(minute),
      turbidity: baselineTurbidity(minute),
      source: 'sensor',
    };
    const cod = codAt(minute);
    if (cod !== null) row.cod = cod;
    rows.push(row);
  }
  return rows;
}

const WORK_ORDERS = [
  {
    id: 'WO-1001',
    createdAt: at(8 * 60 + 10),
    completedAt: at(8 * 60 + 50),
    note: 'E1 期间换水，工单完成后传感器仍超限，事件直到 09:15 才确认恢复',
  },
  {
    id: 'WO-1002',
    createdAt: at(12 * 60 + 25),
    completedAt: at(13 * 60 + 20),
    note: '位于缺测区间，工单不能替代观测，也不能把事件提前封口',
  },
  {
    id: 'WO-1003',
    createdAt: at(17 * 60 + 45),
    completedAt: at(18 * 60 + 20),
    note: '工单已完成，但 E5 到数据结束仍超限，保持未恢复',
  },
];

function buildDataset() {
  return {
    name: '2026-11-01 水质采样（本地造数）',
    generatedAt: new Date().toISOString(),
    splitAt: at(11 * 60), // 治理时点 11:00Z
    splitAtIso: new Date(at(11 * 60)).toISOString(),
    observations: buildObservations(),
    workOrders: WORK_ORDERS.map((wo) => ({
      ...wo,
      createdAtIso: new Date(wo.createdAt).toISOString(),
      completedAtIso: new Date(wo.completedAt).toISOString(),
    })),
    gap: {
      from: at(COD_GAP.from),
      to: at(COD_GAP.to),
      metric: 'cod',
      description: '12:30-13:00 的 COD 观测缺失（氨氮与浊度仍在报数）',
    },
  };
}

/**
 * 根据缺测候选生成补录行。补录值夹在阈值以上，使缺口两侧确实连成一段。
 * 补录行只带 COD，来源标记 manual。
 */
function buildImputationRows(candidate, threshold, note = '补录') {
  if (!candidate || !candidate.from || !candidate.to) {
    throw new Error('缺少可补录的缺测区间');
  }
  const rows = [];
  const floor = Math.max(candidate.previousValue, candidate.nextValue, threshold + 2);
  let i = 0;
  for (let ts = candidate.from + STEP_MS; ts < candidate.to; ts += STEP_MS) {
    rows.push({
      ts,
      cod: Math.round(floor + (i % 3) * 2 - (i % 2)),
      source: 'manual',
      note,
    });
    i += 1;
  }
  return rows;
}

module.exports = {
  DAY,
  STEP_MS,
  at,
  buildDataset,
  buildImputationRows,
};
