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
  isUserAwayFromScreen,
  _resetPerceptionState,
} = await import('../src/perception/state.js');
const { maybeGreetOnReturn, maybeCareOnYawn, maybeReactToExpression, _resetGreeterState } = await import('../src/perception/greeter.js');
const { noteExpressionEvent } = await import('../src/perception/state.js');
const { requestLook, takeLookRequest, completeLook, _resetLookState } = await import('../src/perception/look.js');
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

// ---------- 5.5 级联 v0.3：expression + objects 透传与文案 ----------
{
  _resetPerceptionState();
  const t0 = 550_000;
  ingestPerception(
    'tenA',
    hb({}, {
      presence: true,
      attention: 'screen',
      face: { headPose: { pitch: 0, yaw: 0, roll: 0 }, expression: { label: 'smiling', confidence: 0.9 } },
      objects: [
        { label: 'cup', labelZh: '杯子', pos: 'left', confidence: 0.8 },
        { label: 'book', labelZh: '书', pos: 'center', confidence: 0.7 },
      ],
    }),
    t0,
  );
  const s = getVisionState('tenA', t0 + 500);
  assert.equal(s?.face?.expression?.label, 'smiling', 'expression 透传');
  assert.equal(s?.objects?.length, 2, 'objects 透传');
  let note = buildVisionContextNote('tenA', t0 + 500);
  assert.ok(note?.includes('微笑'), `表情进文案，实际: ${note}`);
  assert.ok(note?.includes('杯子') && note?.includes('书'), `物体进文案，实际: ${note}`);

  // 打哈欠文案 + 物体列表变化
  ingestPerception(
    'tenA',
    hb({ seq: 2 }, {
      presence: true,
      attention: 'screen',
      face: { headPose: { pitch: 0, yaw: 0, roll: 0 }, expression: { label: 'yawning', confidence: 0.8 } },
    }),
    t0 + 1000,
  );
  note = buildVisionContextNote('tenA', t0 + 1500);
  assert.ok(note?.includes('哈欠'), `哈欠文案，实际: ${note}`);
  assert.ok(!note?.includes('杯子'), '新心跳无 objects 则不再提旧物体');

  // v0.3.1 负面表情文案（frowning 带安抚提示）
  ingestPerception(
    'tenA',
    hb({ seq: 1, session_id: 'sess-neg-0001' }, {
      presence: true,
      attention: 'screen',
      face: { headPose: { pitch: 0, yaw: 0, roll: 0 }, expression: { label: 'frowning', confidence: 0.7 } },
    }),
    t0 + 1200,
  );
  note = buildVisionContextNote('tenA', t0 + 1700);
  assert.ok(note?.includes('皱着眉'), `frowning 文案，实际: ${note}`);
  ingestPerception('tenA', hb({ session_id: 'sess-neg-0001', seq: 2 }, {
    presence: true, attention: 'screen',
    face: { headPose: { pitch: 0, yaw: 0, roll: 0 }, expression: { label: 'sad', confidence: 0.6 } },
  }), t0 + 1800);
  note = buildVisionContextNote('tenA', t0 + 1900);
  assert.ok(note?.includes('低落'), `sad 文案，实际: ${note}`);
  assert.ok(note?.includes('没看清'), '防编物体指令在位');

  // expression_change 事件文案带具体表情（30s 短记忆桥：表情瞬时回落后提问仍可命中）
  ingestPerception('tenA', ev('expression_change', { session_id: 'sess-neg-0001', seq: 3 }, { from: 'neutral', to: 'frowning' }), t0 + 2000);
  note = buildVisionContextNote('tenA', t0 + 2400);
  assert.ok(note?.includes('皱了皱眉'), `事件文案带具体表情，实际: ${note}`);

  // v0.2 消息（无 expression/objects）向后兼容：行为与既有一致
  ingestPerception('tenA', hb({ seq: 3 }, { presence: true, attention: 'screen' }), t0 + 2000);
  note = buildVisionContextNote('tenA', t0 + 2500);
  assert.ok(note?.includes('看着屏幕') && !note.includes('微笑'), 'v0.2 兼容');
  console.log('✓ 级联 v0.3 expression/objects 融合');
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

  // event 消息走 ingest 全路径（含 greeter fire-and-forget 钩子，无房间静默）不炸
  res = await post(JSON.stringify(ev('person_enter', { seq: 9 })));
  assert.equal(res.status, 200, 'event 消息 200（greeter 钩子静默）');

  // GET state 快照（验收/调试用）
  res = await app.request('/api/perception/state');
  assert.equal(res.status, 200);
  const snap = (await res.json()) as { ok: boolean; state: { presence: boolean; fresh: boolean } | null };
  assert.equal(snap.state?.presence, true, 'state 快照反映 ingest');
  console.log('✓ ingest 路由');
}

// ---------- 8. ①reminder 联动：isUserAwayFromScreen ----------
{
  _resetPerceptionState();
  const t0 = 600_000;
  // 无视觉状态：不判离开（现有行为不变的保底）
  assert.equal(isUserAwayFromScreen('tenA', t0), false, '无状态不判离开');
  // 在场：不离开
  ingestPerception('tenA', hb({}, { presence: true, attention: 'screen' }), t0);
  assert.equal(isUserAwayFromScreen('tenA', t0 + 500), false);
  // 离席（fresh）：判离开
  ingestPerception('tenA', hb({ seq: 2 }, { presence: false, attention: 'unknown' }), t0 + 1000);
  assert.equal(isUserAwayFromScreen('tenA', t0 + 1500), true, '离席且fresh判离开');
  // 探针离线（stale）：不判离开（宁可白念不可漏念）
  assert.equal(isUserAwayFromScreen('tenA', t0 + 10_000), false, '心跳过期不判离开');
  console.log('✓ isUserAwayFromScreen 判定');
}

// ---------- 9. ②回来打招呼：greeter 状态机 ----------
{
  _resetPerceptionState();
  _resetGreeterState();
  const t0 = 700_000;
  const spoken: string[] = [];
  const deps = {
    listRooms: (tid: string) => (tid === 'tenA' ? ['room-1'] : []),
    speak: async (_room: string, text: string) => {
      spoken.push(text);
    },
  };

  // 离开 60s 后回来 → 打招呼
  await maybeGreetOnReturn('tenA', 'person_leave', t0, deps);
  let r = await maybeGreetOnReturn('tenA', 'person_enter', t0 + 60_000, deps);
  assert.equal(r, 'greeted', `60s 离开回来应打招呼，实际 ${r}`);
  assert.equal(spoken.length, 1);

  // 冷却期内再次 leave/enter → 不打
  await maybeGreetOnReturn('tenA', 'person_leave', t0 + 120_000, deps);
  r = await maybeGreetOnReturn('tenA', 'person_enter', t0 + 180_000, deps);
  assert.equal(r, 'cooldown', '10min 冷却内不重复打招呼');

  // 冷却过后：短暂离开（<30s）→ 不打（低头捡东西不算离开）
  _resetGreeterState();
  await maybeGreetOnReturn('tenA', 'person_leave', t0, deps);
  r = await maybeGreetOnReturn('tenA', 'person_enter', t0 + 10_000, deps);
  assert.equal(r, 'too-short', '短暂消失不打招呼');

  // 离开太久（>30min）→ 不打
  _resetGreeterState();
  await maybeGreetOnReturn('tenA', 'person_leave', t0, deps);
  r = await maybeGreetOnReturn('tenA', 'person_enter', t0 + 31 * 60_000, deps);
  assert.equal(r, 'too-long', '离开超 30min 不打招呼');

  // 无活跃房间 → 不打
  _resetGreeterState();
  await maybeGreetOnReturn('tenB', 'person_leave', t0, deps);
  r = await maybeGreetOnReturn('tenB', 'person_enter', t0 + 60_000, deps);
  assert.equal(r, 'no-room', '无活跃房间不打招呼');

  // 没有 leave 直接 enter（如探针刚启动）→ 不打
  _resetGreeterState();
  r = await maybeGreetOnReturn('tenA', 'person_enter', t0 + 60_000, deps);
  assert.equal(r, 'no-leave', '无离开记录不打招呼');

  // speak 失败不抛（静默）
  _resetGreeterState();
  const failDeps = {
    listRooms: () => ['room-x'],
    speak: async () => {
      throw new Error('rtc down');
    },
  };
  await maybeGreetOnReturn('tenA', 'person_leave', t0, failDeps);
  r = await maybeGreetOnReturn('tenA', 'person_enter', t0 + 60_000, failDeps);
  assert.equal(r, 'speak-failed', 'RTC 失败静默不抛');
  console.log('✓ greeter 状态机');
}

// ---------- 10. 哈欠主动关怀 ----------
{
  _resetGreeterState();
  const t0 = 800_000;
  const spoken: string[] = [];
  const deps = {
    listRooms: (tid: string) => (tid === 'tenA' ? ['room-1'] : []),
    speak: async (_room: string, text: string) => {
      spoken.push(text);
    },
  };
  let r = await maybeCareOnYawn('tenA', 'yawning', t0, deps);
  assert.equal(r, 'greeted', `真哈欠应关怀，实际 ${r}`);
  assert.ok(spoken[0]?.includes('困'), '关怀话术');
  // 同表情 3min 冷却（demo 节奏）
  r = await maybeCareOnYawn('tenA', 'yawning', t0 + 2 * 60_000, deps);
  assert.equal(r, 'cooldown', '冷却内不重复关怀');
  r = await maybeCareOnYawn('tenA', 'yawning', t0 + 4 * 60_000, deps);
  assert.equal(r, 'greeted', '冷却过后可再关怀');
  // 非 yawning 表情经 deprecated 入口不触发关怀（新表情反应走 maybeReactToExpression 有自己的用例）
  r = await maybeCareOnYawn('tenA', 'smiling', t0 + 62 * 60_000, deps);
  assert.equal(r, 'ignored', '兼容入口只认哈欠');
  // 无房间静默
  r = await maybeCareOnYawn('tenB', 'yawning', t0, deps);
  assert.equal(r, 'no-room');
  console.log('✓ 哈欠主动关怀');
}

// ---------- 11. 表情主动交互（全表情反应+三层防骚扰） ----------
{
  _resetGreeterState();
  const t0 = 900_000;
  const spoken: string[] = [];
  const deps = {
    listRooms: (tid: string) => (tid === 'tenA' ? ['room-1'] : []),
    speak: async (_room: string, text: string) => {
      spoken.push(text);
    },
  };
  // frowning → 关心/调侃
  let r = await maybeReactToExpression('tenA', 'frowning', t0, deps);
  assert.equal(r, 'greeted');
  assert.ok(spoken[0]?.includes('眉'), `皱眉话术，实际 ${spoken[0]}`);
  // 全局冷却：30s 后换 sad 也不说（跨表情 ≥1min）
  r = await maybeReactToExpression('tenA', 'sad', t0 + 30_000, deps);
  assert.equal(r, 'cooldown', '全局冷却拦截连环骚扰');
  // 全局冷却过后 sad 触发
  r = await maybeReactToExpression('tenA', 'sad', t0 + 70_000, deps);
  assert.equal(r, 'greeted');
  // 同表情 3min 冷却：frowning 2.5min 时仍拦、3.5min 放行
  r = await maybeReactToExpression('tenA', 'frowning', t0 + 150_000, deps);
  assert.equal(r, 'cooldown', '同表情 3min 冷却');
  r = await maybeReactToExpression('tenA', 'frowning', t0 + 215_000, deps);
  assert.equal(r, 'greeted', '3min 后同表情放行');
  // eyes_closed / neutral 不响应（想静静）
  r = await maybeReactToExpression('tenA', 'eyes_closed', t0 + 120 * 60_000, deps);
  assert.equal(r, 'ignored');
  r = await maybeReactToExpression('tenA', 'neutral', t0 + 121 * 60_000, deps);
  assert.equal(r, 'ignored');
  console.log('✓ 表情主动交互');
}

// ---------- 12. 开场关怀：30min 负面表情摘要 ----------
{
  _resetPerceptionState();
  const t0 = 1_000_000;
  ingestPerception('tenA', hb({}, { presence: true, attention: 'screen' }), t0);
  // 1 次负面：不带摘要
  noteExpressionEvent('tenA', 'frowning', t0 - 10 * 60_000);
  let note = buildVisionContextNote('tenA', t0 + 500);
  assert.ok(!note?.includes('过去半小时'), '<2 次不带摘要');
  // 2 次负面：带摘要
  noteExpressionEvent('tenA', 'sad', t0 - 5 * 60_000);
  note = buildVisionContextNote('tenA', t0 + 500);
  assert.ok(note?.includes('过去半小时') && note.includes('2 次'), `开场关怀摘要，实际: ${note}`);
  // 30min 窗外过期
  note = buildVisionContextNote('tenA', t0 + 26 * 60_000);
  assert.ok(!note?.includes('过去半小时'), '窗外过期不再提');
  // smiling 不计入负面
  _resetPerceptionState();
  ingestPerception('tenA', hb({}, { presence: true, attention: 'screen' }), t0);
  noteExpressionEvent('tenA', 'smiling', t0);
  noteExpressionEvent('tenA', 'smiling', t0 + 1000);
  note = buildVisionContextNote('tenA', t0 + 2000);
  assert.ok(!note?.includes('过去半小时'), '微笑不触发关怀摘要');
  console.log('✓ 开场关怀摘要');
}

// ---------- 13. 切片3：look 状态机（请求→取走→完成插播；超时兜底） ----------
{
  _resetLookState();
  const spoken: Array<{ room: string; text: string }> = [];
  const deps = {
    speak: async (room: string, text: string) => {
      spoken.push({ room, text });
    },
  };
  // 请求→探针取走（只取一次）→完成→插播第二段
  requestLook('tenA', 'room-9', '我手里拿的什么', deps);
  assert.deepEqual(takeLookRequest('tenA'), { question: '我手里拿的什么' });
  assert.equal(takeLookRequest('tenA'), null, '同一请求只取一次');
  assert.equal(takeLookRequest('tenB'), null, '租户隔离');
  const consumed = await completeLook('tenA', '你拿着一瓶矿泉水，绿色标签。', deps);
  assert.equal(consumed, true);
  assert.ok(spoken[0]?.text.startsWith('看清了——'), `第二段插播，实际 ${spoken[0]?.text}`);
  assert.equal(spoken[0]?.room, 'room-9');
  // 无在途请求时 semantic 到达不插播
  assert.equal(await completeLook('tenA', '孤儿描述', deps), false);
  // 空描述→"没看清"话术
  requestLook('tenA', 'room-9', 'q2', deps);
  takeLookRequest('tenA');
  await completeLook('tenA', '   ', deps);
  assert.ok(spoken[1]?.text.includes('没看太清'), '空描述兜底话术');
  // 新请求顶掉旧请求（同租户一次一个）
  requestLook('tenA', 'room-9', '旧问题', deps);
  requestLook('tenA', 'room-9', '新问题', deps);
  assert.deepEqual(takeLookRequest('tenA'), { question: '新问题' });
  _resetLookState();
  console.log('✓ look 状态机');
}

console.log('\nperception.test 全部通过 ✅');
