/**
 * Vision V0 perception 内核单测：契约 v0.2 信封校验 / 租户级 visionState 融合 /
 * TTL 离线判定 / L1 事件窗 / visionContextNote 生成 / ingest 路由。
 * 跑法：npm run test:perception
 */
process.env.MYJAVIS_MEMORY_DB = ':memory:';
process.env.VISION_ENABLED = '1'; // 必须在 import config 之前（config 模块加载时读 env）

import assert from 'node:assert/strict';
import { Hono } from 'hono';

const {
  validateEnvelope,
  ingestPerception,
  getVisionState,
  buildVisionContextNote,
  _resetPerceptionState,
} = await import('../src/perception/state.js');
const { perceptionRoute } = await import('../src/routes/perception.js');
const { createTenant } = await import('../src/tenant/registry.js');

type Envelope = Record<string, unknown>;
const hb = (over: Envelope = {}, payload: Envelope = {}): Envelope => ({
  v: '0.2.0',
  type: 'heartbeat',
  seq: 1,
  session_id: 'sess-12345678',
  ts_mono_ms: 1000,
  ts_wall_ms: 1_720_000_000_000,
  payload: { presence: true, attention: 'screen', ...payload },
  ...over,
});
const ev = (kind: string, over: Envelope = {}, payload: Envelope = {}): Envelope => ({
  v: '0.2.0',
  type: 'event',
  seq: 10,
  session_id: 'sess-12345678',
  ts_mono_ms: 2000,
  ts_wall_ms: 1_720_000_000_000,
  payload: { kind, ...payload },
  ...over,
});

// ---------- 1. 信封校验（契约 §1） ----------
{
  assert.equal(validateEnvelope(hb()).ok, true, '合法 v0.2 心跳应通过');
  const missing = validateEnvelope({ v: '0.2.0', type: 'heartbeat' });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /missing/, '缺必填字段应报 missing');
  assert.equal(validateEnvelope(hb({ type: 'bogus' })).ok, false, '未知 type 应拒绝');
  assert.equal(validateEnvelope(hb({ v: '1.0.0' })).ok, false, '主版本不匹配应拒绝');
  assert.equal(validateEnvelope(hb({ payload: 'not-obj' })).ok, false, 'payload 非对象应拒绝');
  assert.equal(validateEnvelope(hb({ seq: -1 })).ok, false, '负 seq 应拒绝');
  console.log('✓ 信封校验');
}

// ---------- 2. heartbeat 融合 + seq 单调 + session 接管 ----------
{
  _resetPerceptionState();
  const t0 = 100_000;
  ingestPerception('tenA', hb(), t0);
  let s = getVisionState('tenA', t0 + 500);
  assert.ok(s, '应有状态');
  assert.equal(s?.presence, true);
  assert.equal(s?.attention, 'screen');
  assert.equal(s?.fresh, true, '0.5s 内 fresh');

  // 同 session 旧 seq 忽略（乱序/重放防御）
  ingestPerception('tenA', hb({ seq: 1 }, { presence: false, attention: 'away' }), t0 + 600);
  s = getVisionState('tenA', t0 + 700);
  assert.equal(s?.presence, true, '重复 seq 不应覆盖状态');

  // 新 seq 正常推进
  ingestPerception('tenA', hb({ seq: 2 }, { presence: true, attention: 'away' }), t0 + 800);
  s = getVisionState('tenA', t0 + 900);
  assert.equal(s?.attention, 'away');

  // 新 session_id 接管：seq 归零合法（探针重启）
  ingestPerception('tenA', hb({ session_id: 'sess-88888888', seq: 0 }, { presence: false, attention: 'unknown' }), t0 + 1000);
  s = getVisionState('tenA', t0 + 1100);
  assert.equal(s?.presence, false, '新 session 低 seq 应接管');

  // face 节透传保存
  ingestPerception(
    'tenA',
    hb({ session_id: 'sess-88888888', seq: 1 }, { face: { headPose: { pitch: 1, yaw: -2, roll: 16 }, attrs: { eyesOpen: true } } }),
    t0 + 1200,
  );
  s = getVisionState('tenA', t0 + 1300);
  assert.equal(s?.face?.headPose?.roll, 16, 'face 节应保存');
  console.log('✓ heartbeat 融合/seq 单调/session 接管');
}

// ---------- 3. TTL：心跳缺失 >3s = 离线（契约 §2 L0） ----------
{
  _resetPerceptionState();
  const t0 = 200_000;
  ingestPerception('tenA', hb(), t0);
  assert.equal(getVisionState('tenA', t0 + 2900)?.fresh, true, '2.9s 内 fresh');
  assert.equal(getVisionState('tenA', t0 + 3100)?.fresh, false, '3.1s 视为离线');
  assert.equal(buildVisionContextNote('tenA', t0 + 3100), undefined, '离线不注入');
  console.log('✓ TTL 离线判定');
}

// ---------- 4. L1 事件窗：30s 淘汰 + 环上限 ----------
{
  _resetPerceptionState();
  const t0 = 300_000;
  ingestPerception('tenA', hb(), t0);
  ingestPerception('tenA', ev('head_nod', { seq: 11 }), t0 + 1000);
  ingestPerception('tenA', ev('person_leave', { seq: 12 }), t0 + 2000);
  let s = getVisionState('tenA', t0 + 3000);
  assert.equal(s?.recentEvents.length, 2);
  assert.equal(s?.recentEvents[0]?.kind, 'head_nod');

  // 30s 窗外淘汰（读取时过滤）
  s = getVisionState('tenA', t0 + 33_000);
  assert.equal(s?.recentEvents.length, 0, '30s 外事件应淘汰');

  // 环上限：塞 12 条只留最新 8 条
  for (let i = 0; i < 12; i++) ingestPerception('tenA', ev('head_nod', { seq: 20 + i }), t0 + 40_000 + i * 10);
  s = getVisionState('tenA', t0 + 41_000);
  assert.equal(s?.recentEvents.length, 8, '事件环上限 8');
  console.log('✓ L1 事件窗');
}

// ---------- 5. visionContextNote 生成 ----------
{
  _resetPerceptionState();
  const t0 = 400_000;
  assert.equal(buildVisionContextNote('tenA', t0), undefined, '无状态不注入');

  ingestPerception('tenA', hb({}, { presence: true, attention: 'screen' }), t0);
  let note = buildVisionContextNote('tenA', t0 + 500);
  assert.ok(note?.includes('看着屏幕'), `screen 文案，实际: ${note}`);
  assert.ok(note?.includes('[视觉感知]'), '带标识前缀');

  ingestPerception('tenA', hb({ seq: 2 }, { presence: true, attention: 'away' }), t0 + 1000);
  note = buildVisionContextNote('tenA', t0 + 1500);
  assert.ok(note?.includes('视线不在屏幕'), `away 文案，实际: ${note}`);

  ingestPerception('tenA', hb({ seq: 3 }, { presence: false, attention: 'unknown' }), t0 + 2000);
  note = buildVisionContextNote('tenA', t0 + 2500);
  assert.ok(note?.includes('没有人'), `离席文案，实际: ${note}`);

  // 近期事件带入（点头）
  ingestPerception('tenA', hb({ seq: 4 }, { presence: true, attention: 'screen' }), t0 + 3000);
  ingestPerception('tenA', ev('head_nod', { seq: 5 }), t0 + 3200);
  note = buildVisionContextNote('tenA', t0 + 3500);
  assert.ok(note?.includes('点头'), `nod 事件文案，实际: ${note}`);
  console.log('✓ visionContextNote 文案');
}

// ---------- 6. 租户隔离 ----------
{
  _resetPerceptionState();
  const t0 = 500_000;
  ingestPerception('tenA', hb(), t0);
  assert.equal(getVisionState('tenB', t0 + 100), undefined, '租户 B 无状态');
  assert.equal(buildVisionContextNote('tenB', t0 + 100), undefined);
  console.log('✓ 租户隔离');
}

// ---------- 7. ingest 路由（校验/限长/无租户/GET state） ----------
{
  _resetPerceptionState();
  const tenant = createTenant('vision测试租户');
  const app = new Hono();
  // 模拟 index.ts 全局中间件：注入租户
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set('tenant', c.req.header('x-test-no-tenant') ? null : tenant);
    (c as unknown as { set: (k: string, v: unknown) => void }).set('isAdmin', false);
    await next();
  });
  app.route('/api/perception', perceptionRoute);

  const post = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
    app.request('/api/perception/ingest', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    });

  let res = await post(JSON.stringify(hb()));
  assert.equal(res.status, 200, '合法消息 200');
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);

  res = await post('{broken json');
  assert.equal(res.status, 400, '坏 JSON 400');

  res = await post(JSON.stringify({ v: '0.2.0', type: 'heartbeat' }));
  assert.equal(res.status, 400, '信封缺字段 400');

  res = await post(JSON.stringify(hb({ v: '1.0.0' })));
  assert.equal(res.status, 400, '主版本不匹配 400');

  res = await post('x'.repeat(33 * 1024));
  assert.equal(res.status, 413, '超 32KB 413');

  res = await post(JSON.stringify(hb()), { 'x-test-no-tenant': '1' });
  assert.equal(res.status, 403, '无租户 403');

  // GET state 快照（验收/调试用）
  res = await app.request('/api/perception/state');
  assert.equal(res.status, 200);
  const snap = (await res.json()) as { ok: boolean; state: { presence: boolean; fresh: boolean } | null };
  assert.equal(snap.state?.presence, true, 'state 快照反映 ingest');
  console.log('✓ ingest 路由');
}

console.log('\nperception.test 全部通过 ✅');
