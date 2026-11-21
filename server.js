'use strict';

/**
 * 本地演示服务。只使用 Node.js 内置模块。
 *
 * API：
 *   GET  /api/state                 当前观测、事件、缺口与默认对照
 *   POST /api/events/generate       重置为本地造数并计算事件
 *   POST /api/impute                补录一段缺失观测（默认自动补当前缺口）
 *   POST /api/compare               按治理时点 / 归并口径对照恢复时长
 *
 * 启动：PORT=3000 node server.js  （仅绑定 127.0.0.1）
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  computeQualityEvents,
  compareRecovery,
  mergeImputedObservations,
  parseObservations,
  InputError,
  THRESHOLDS,
} = require('./lib/events');
const { buildDataset, buildImputationRows } = require('./lib/dataset');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

const MAX_BODY_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 会话状态                                                             */
/* ------------------------------------------------------------------ */

function createStore() {
  const dataset = buildDataset();
  let observations = dataset.observations.map((row) => ({ ...row }));
  let imputations = [];
  let seq = 0;

  function currentRun() {
    return computeQualityEvents(observations);
  }

  function reset() {
    observations = dataset.observations.map((row) => ({ ...row }));
    imputations = [];
    seq = 0;
    return currentRun();
  }

  function snapshot({ splitAt = dataset.splitAtIso, windowMode = 'confirmed' } = {}) {
    const run = currentRun();
    const comparison = compareRecovery(run, { splitAt, windowMode });
    return {
      dataset: {
        name: dataset.name,
        splitAtIso: dataset.splitAtIso,
        gap: {
          ...dataset.gap,
          fromIso: new Date(dataset.gap.from).toISOString(),
          toIso: new Date(dataset.gap.to).toISOString(),
        },
      },
      observations: observations.map((row) => ({
        ts: row.ts,
        tsIso: new Date(row.ts).toISOString(),
        cod: row.cod,
        ammonia: row.ammonia,
        turbidity: row.turbidity,
        source: row.source,
        ...(row.note ? { note: row.note } : {}),
      })),
      workOrders: dataset.workOrders,
      imputations,
      run: {
        options: run.options,
        thresholds: run.thresholds,
        metricLabels: run.metricLabels,
        observationCount: run.observationCount,
        events: run.events,
        openEvents: run.openEvents,
        summary: run.summary,
        gaps: run.gaps,
        mergeCandidates: run.mergeCandidates,
      },
      comparison,
    };
  }

  /**
   * 执行补录。默认取当前第一个可合并缺口，自动生成填补行；
   * 也接受调用方给定的 rows（结构与传感器观测相同）。
   */
  function impute({ candidate, rows, metric = 'cod', note = '补录' } = {}) {
    const run = currentRun();
    const chosen = candidate
      ? run.mergeCandidates.find((c) =>
        c.metric === candidate.metric &&
        c.from === toMs(candidate.from) &&
        c.to === toMs(candidate.to))
      : run.mergeCandidates[0];

    if (!chosen && !Array.isArray(rows)) {
      throw new InputError(candidate
        ? '该缺口当前不存在或已被补齐'
        : '当前没有可由补录合并的缺测区间');
    }

    const target = chosen || normalizeCandidate(candidate, metric);
    if (!Object.hasOwn(THRESHOLDS, target.metric)) {
      throw new InputError(`不支持的指标：${target.metric}`);
    }
    let added;
    if (Array.isArray(rows) && rows.length > 0) {
      added = parseObservations(rows, { source: 'manual' }).map((obs) => ({
        ts: obs.ts,
        ...obs.metrics,
        source: obs.source,
        ...(obs.note ? { note: obs.note } : {}),
      }));
    } else {
      added = buildImputationRows(target, THRESHOLDS[target.metric], note);
    }

    if (added.length === 0) {
      throw new InputError('补录至少需要一条观测');
    }
    for (const row of added) {
      if (row.ts <= target.from || row.ts >= target.to) {
        throw new InputError('补录观测必须落在缺口区间内部');
      }
    }

    const before = {
      summary: run.summary,
      resolvedCount: run.events.length,
      openCount: run.openEvents.length,
      mergeCandidateCount: run.mergeCandidates.length,
      meanDurationMinutes: run.summary.meanDurationMinutes,
    };

    observations = mergeImputedObservations(observations, added);
    seq += 1;
    imputations.push({
      id: `IMP-${String(seq).padStart(3, '0')}`,
      metric: target.metric,
      from: target.from,
      to: target.to,
      fromIso: new Date(target.from).toISOString(),
      toIso: new Date(target.to).toISOString(),
      count: added.length,
      rows: added.map((row) => ({
        ...row,
        tsIso: new Date(row.ts).toISOString(),
      })),
    });

    const afterRun = currentRun();
    // 补录行可能落在某个已恢复事件里，也可能让两段合并；取包含补录读数的事件。
    const afterEvent = [...afterRun.events, ...afterRun.openEvents].find((event) =>
      event.readings.some((r) => r.source === 'manual'));
    // 补录前与缺口相交的已恢复段和未恢复段，用于说明合并没有沿用旧时长。
    const beforeSegments = [...run.events, ...run.openEvents]
      .filter((e) => e.metric === target.metric && eventOverlapsGap(e, target))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((e) => ({
        status: e.status,
        startedAtIso: e.startedAtIso,
        confirmedAtIso: e.confirmedAtIso,
        durationMinutes: e.durationMinutes,
      }));

    return {
      before,
      after: {
        resolvedCount: afterRun.events.length,
        openCount: afterRun.openEvents.length,
        mergeCandidateCount: afterRun.mergeCandidates.length,
        meanDurationMinutes: afterRun.summary.meanDurationMinutes,
      },
      mergedEvent: afterEvent
        ? {
          metric: afterEvent.metric,
          startedAtIso: afterEvent.startedAtIso,
          recoveredAtIso: afterEvent.recoveredAtIso,
          confirmedAtIso: afterEvent.confirmedAtIso,
          durationMinutes: afterEvent.durationMinutes,
          previousSegments: beforeSegments,
          note: '合并后时长按合并段首尾重新计算，不沿用补录前事件的平均值',
        }
        : null,
    };
  }

  return { dataset, snapshot, reset, impute, currentRun };
}

function toMs(value) {
  if (typeof value === 'number') return value;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeCandidate(candidate, metric) {
  if (!candidate) throw new InputError('缺少缺口信息');
  const from = toMs(candidate.from);
  const to = toMs(candidate.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new InputError('缺口起止时间不合法');
  }
  return {
    metric,
    from,
    to,
    previousValue: Number(candidate.previousValue) || THRESHOLDS[metric] + 1,
    nextValue: Number(candidate.nextValue) || THRESHOLDS[metric] + 1,
  };
}

function eventOverlapsGap(event, gap) {
  return event.startedAt <= gap.to && (event.confirmedAt ?? Infinity) >= gap.from;
}

/* ------------------------------------------------------------------ */
/* HTTP 基础设施                                                        */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof InputError ? error.statusCode : 500;
  if (status >= 500) console.error(error);
  sendJson(res, status, {
    ok: false,
    error: error.message || '服务内部错误',
    ...(error instanceof InputError ? {} : { code: 'INTERNAL' }),
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new InputError('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new InputError('请求体需为 JSON 对象');
        }
        resolve(parsed);
      } catch (error) {
        reject(error instanceof InputError ? error : new InputError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 从请求体读对照视图参数；缺省沿用数据集默认值。 */
function viewOptions(body) {
  const options = {};
  if (body && body.splitAt !== undefined) options.splitAt = body.splitAt;
  if (body && body.windowMode !== undefined) options.windowMode = body.windowMode;
  return options;
}

function createServer(store = createStore()) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname } = url;

    try {
      if (req.method === 'GET' && STATIC_FILES.has(pathname)) {
        const entry = STATIC_FILES.get(pathname);
        const data = fs.readFileSync(path.join(PUBLIC_DIR, entry.file));
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
        });
        res.end(data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, { ok: true, ...store.snapshot() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/events/generate') {
        const body = await readJsonBody(req);
        const run = store.reset();
        sendJson(res, 200, {
          ok: true,
          generated: {
            observationCount: run.observationCount,
            resolvedCount: run.events.length,
            openCount: run.openEvents.length,
            meanDurationMinutes: run.summary.meanDurationMinutes,
            mergeCandidateCount: run.mergeCandidates.length,
          },
          ...store.snapshot(viewOptions(body)),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/impute') {
        const body = await readJsonBody(req);
        const result = store.impute(body);
        sendJson(res, 200, { ok: true, result, ...store.snapshot(viewOptions(body)) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/compare') {
        const body = await readJsonBody(req);
        const splitAt = body.splitAt === undefined ? store.dataset.splitAtIso : body.splitAt;
        const windowMode = body.windowMode === undefined ? 'confirmed' : body.windowMode;
        sendJson(res, 200, {
          ok: true,
          comparison: compareRecovery(store.currentRun(), { splitAt, windowMode }),
        });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: '接口不存在' });
        return;
      }

      sendJson(res, 404, { ok: false, error: '路径不存在' });
    } catch (error) {
      sendError(res, error);
    }
  });
}

if (require.main === module) {
  const rawPort = process.env.PORT;
  const port = rawPort === undefined ? 3000 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 不合法: ${rawPort}`);
    process.exit(1);
  }
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log(`水质事件演示已启动: http://127.0.0.1:${address.port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, createStore, STATIC_FILES };
