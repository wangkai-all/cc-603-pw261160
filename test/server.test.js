'use strict';

/**
 * HTTP 层用例：真实起服务、走接口，覆盖页面依赖的成功/失败返回，
 * 并验证业务结果区带 data-evidence-result。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../server');

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  return { status: res.status, headers: res.headers, body: isJson ? await res.json() : await res.text() };
}

test('GET / 返回页面并带有 data-evidence-result 结果区', async () => {
  await withServer(async (base) => {
    const res = await call(base, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.body, /data-evidence-result/);
    for (const label of ['生成水质事件', '补一段缺失观测', '对照恢复时长']) {
      assert.ok(res.body.includes(label), `页面缺少按钮：${label}`);
    }
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('GET /api/state 返回事件、未恢复样本与默认对照', async () => {
  await withServer(async (base) => {
    const { status, body } = await call(base, 'GET', '/api/state');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.run.events.length, 4);
    assert.equal(body.run.openEvents.length, 2);
    assert.equal(body.run.mergeCandidates.length, 1);
    assert.equal(body.comparison.pendingStats.count, 2);
    assert.equal(body.workOrders.length, 3);
    assert.ok(body.run.thresholds.cod > 0);
  });
});

test('POST /api/events/generate 重置数据并重新算出同样的结果', async () => {
  await withServer(async (base) => {
    await call(base, 'POST', '/api/impute', {});
    const first = await call(base, 'GET', '/api/state');
    assert.equal(first.body.imputations.length, 1);

    const { status, body } = await call(base, 'POST', '/api/events/generate');
    assert.equal(status, 200);
    assert.equal(body.generated.resolvedCount, 4);
    assert.equal(body.generated.openCount, 2);
    assert.equal(body.imputations.length, 0, '重置会清空补录');
    assert.equal(body.run.mergeCandidates.length, 1);
  });
});

test('POST /api/impute 合并两段并返回新旧对比', async () => {
  await withServer(async (base) => {
    const { status, body } = await call(base, 'POST', '/api/impute', {});
    assert.equal(status, 200);
    assert.equal(body.imputations.length, 1);
    assert.equal(body.imputations[0].count, 5);
    assert.equal(body.result.after.mergeCandidateCount, 0);
    assert.equal(body.result.mergedEvent.durationMinutes, 80);
    assert.deepEqual(
      body.result.mergedEvent.previousSegments.map((e) => e.durationMinutes),
      [10, 40],
      '补录前的截断段与缺口后段都列出，合并后按时长首尾重算',
    );
    assert.deepEqual(
      body.result.mergedEvent.previousSegments.map((e) => e.status),
      ['open', 'resolved'],
    );
    // 合并后的段落在 12:20，补录后未恢复样本少了一个。
    assert.equal(body.run.openEvents.length, 1);
    assert.ok(body.observations.some((o) => o.source === 'manual'));
  });
});

test('POST /api/impute 重复调用时返回明确的 400', async () => {
  await withServer(async (base) => {
    await call(base, 'POST', '/api/impute', {});
    const { status, body } = await call(base, 'POST', '/api/impute', {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /没有可由补录合并/);
  });
});

test('POST /api/impute 拒绝落在缺口外的补录行', async () => {
  await withServer(async (base) => {
    const state = await call(base, 'GET', '/api/state');
    const candidate = state.body.run.mergeCandidates[0];
    const { status, body } = await call(base, 'POST', '/api/impute', {
      candidate: { metric: candidate.metric, from: candidate.from, to: candidate.to },
      rows: [{ ts: candidate.from, cod: 60 }],
    });
    assert.equal(status, 400);
    assert.match(body.error, /缺口区间内部/);
  });
});

test('POST /api/compare 支持两种归并口径', async () => {
  await withServer(async (base) => {
    const state = await call(base, 'GET', '/api/state');
    const splitAt = state.body.dataset.splitAtIso;

    const confirmed = await call(base, 'POST', '/api/compare', { splitAt, windowMode: 'confirmed' });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.comparison.windowMode, 'confirmed');
    assert.equal(confirmed.body.comparison.beforeStats.count, 1);
    assert.equal(confirmed.body.comparison.afterStats.count, 3);
    assert.equal(confirmed.body.comparison.pendingStats.count, 2);
    assert.equal(confirmed.body.comparison.verdict, 'partial');

    const observed = await call(base, 'POST', '/api/compare', { splitAt, windowMode: 'observed' });
    assert.equal(observed.body.comparison.beforeStats.count, 2);
    assert.equal(observed.body.comparison.afterStats.count, 2);
  });
});

test('POST /api/compare 的非法输入返回 400', async () => {
  await withServer(async (base) => {
    const badTime = await call(base, 'POST', '/api/compare', { splitAt: 'yesterday-ish' });
    assert.equal(badTime.status, 400);

    const badMode = await call(base, 'POST', '/api/compare', {
      splitAt: '2026-11-01T11:00:00Z',
      windowMode: 'rolling',
    });
    assert.equal(badMode.status, 400);

    const badJson = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).ok, false);
  });
});

test('未知接口与未知路径返回 404', async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, 'GET', '/api/nope')).status, 404);
    assert.equal((await call(base, 'GET', '/nope')).status, 404);
  });
});
