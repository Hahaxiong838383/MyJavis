/**
 * R4 提炼代理单测：refineBatch 核心决策解析（mock LLM，防幻觉/角色过滤/坏输出容错）+
 * POST /api/memory/refine 路由校验层（鉴权/入参/批量上限）。
 * 跑法：npm run test:memory-refine
 *
 * 路由测试刻意不覆盖真实 LLM 200 成功解析路径（route 内部直调 createLlm()，无注入点，
 * 需要真实/网络可达的 LLM 端点）——该路径的防幻觉/解析逻辑已由本文件第 1 节的
 * refineBatch() 直调覆盖（mock LlmProvider）；HTTP 层的真实端到端联调见完成报告里的
 * curl E2E（本地起一个假 OpenAI 兼容 SSE 服务模拟 LLM）。
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { refineBatch, type RefineBatchItem } from '../src/memory/refine-proxy.js';
import { memoryRefineRoute } from '../src/routes/memory-refine.js';
import type { LlmProvider } from '../src/providers/types.js';
import type { Tenant } from '../src/tenant/registry.js';

const mkLlm = (raw: string, onCall?: () => void): LlmProvider => ({
  streamChat: async (args) => {
    onCall?.();
    args.onDone(raw);
  },
});

// ========== 1) refineBatch 核心决策解析（mock LLM，无 HTTP） ==========

// —— 1a) 无 pending 条目：不调 LLM，直接返回空数组 ——
{
  let calls = 0;
  const items: RefineBatchItem[] = [{ id: 1, role: 'context', type: 'preference', key: 'preference.drink', value: '旧偏好' }];
  const decisions = await refineBatch(items, mkLlm('{"decisions":[]}', () => calls++));
  assert.equal(decisions.length, 0);
  assert.equal(calls, 0, '全 context 无 pending 时不应调用 LLM');
  console.log('✓ 无 pending 条目不调 LLM');
}

// —— 1b) happy path：ADD/UPDATE/DELETE/NONE 四路全部正确解析 ——
{
  const items: RefineBatchItem[] = [
    { id: 1, role: 'pending', type: 'preference', key: 'preference.drink', value: '喜欢冰美式' },
    { id: 2, role: 'pending', type: 'preference', key: 'preference.drink', value: '现在爱喝拿铁' },
    { id: 3, role: 'context', type: 'preference', key: 'preference.snack', value: '喜欢薯片' },
    { id: 4, role: 'pending', type: 'event', key: 'event.trip', value: '周三去深圳出差' },
    { id: 5, role: 'pending', type: 'preference', key: 'preference.music', value: '不确定的偏好' },
  ];
  const raw = JSON.stringify({
    decisions: [
      { id: 1, action: 'DELETE', mergeWithId: 2, reason: '被 id=2 取代' },
      { id: 2, action: 'ADD' },
      { id: 4, action: 'UPDATE', mergeWithId: 3, value: '合并后的表述' },
      { id: 5, action: 'NONE' },
    ],
  });
  const decisions = await refineBatch(items, mkLlm(raw));
  assert.equal(decisions.length, 4);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  assert.equal(byId.get(1)?.action, 'DELETE');
  assert.equal(byId.get(1)?.mergeWithId, 2);
  assert.equal(byId.get(2)?.action, 'ADD');
  assert.equal(byId.get(4)?.action, 'UPDATE');
  assert.equal(byId.get(4)?.mergeWithId, 3, 'mergeWithId 可以引用 context 条目');
  assert.equal(byId.get(4)?.value, '合并后的表述');
  assert.equal(byId.get(5)?.action, 'NONE');
  console.log('✓ happy path 四路决策解析');
}

// —— 1c) 防幻觉：id 不在批次内的决策整条丢弃；mergeWithId 幻觉时只丢 mergeWithId 不丢决策本身 ——
{
  const items: RefineBatchItem[] = [{ id: 1, role: 'pending', type: 'preference', key: 'preference.drink', value: '喜欢冰美式' }];
  const raw = JSON.stringify({
    decisions: [
      { id: 99, action: 'ADD' }, // 幻觉编号：整条丢弃
      { id: 1, action: 'UPDATE', mergeWithId: 88, value: 'x' }, // mergeWithId 幻觉：字段丢弃，决策保留
    ],
  });
  const decisions = await refineBatch(items, mkLlm(raw));
  assert.equal(decisions.length, 1, '幻觉编号的决策应整条丢弃');
  assert.equal(decisions[0]!.id, 1);
  assert.equal(decisions[0]!.mergeWithId, undefined, '幻觉 mergeWithId 应被丢弃');
  console.log('✓ 防幻觉（id 越界丢整条 / mergeWithId 越界丢字段）');
}

// —— 1d) 坏输出容错：非 JSON → 空数组不抛错 ——
{
  const items: RefineBatchItem[] = [{ id: 1, role: 'pending', type: 'preference', key: 'preference.drink', value: '喜欢冰美式' }];
  const decisions = await refineBatch(items, mkLlm('抱歉我不能输出 JSON'));
  assert.equal(decisions.length, 0, '坏输出应零决策不抛错');
  console.log('✓ 坏输出容错');
}

// —— 1e) context 角色即使被 LLM 误判出决策也不下发（只认 pending） ——
{
  const items: RefineBatchItem[] = [
    { id: 1, role: 'pending', type: 'preference', key: 'preference.drink', value: '喜欢冰美式' },
    { id: 2, role: 'context', type: 'preference', key: 'preference.drink', value: '旧的' },
  ];
  const raw = JSON.stringify({ decisions: [{ id: 1, action: 'ADD' }, { id: 2, action: 'DELETE' }] });
  const decisions = await refineBatch(items, mkLlm(raw));
  assert.equal(decisions.length, 1, 'context 编号的决策应被过滤');
  assert.equal(decisions[0]!.id, 1);
  console.log('✓ context 角色不下发决策');
}

// ========== 2) POST /api/memory/refine 路由校验层 ==========
{
  const tenant: Tenant = {
    id: 'tn-refine-test',
    name: '提炼代理测试租户',
    token: 'jv-test-test',
    soloMode: true,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set('tenant', c.req.header('x-test-no-tenant') ? null : tenant);
    (c as unknown as { set: (k: string, v: unknown) => void }).set('isAdmin', false);
    await next();
  });
  app.route('/api/memory', memoryRefineRoute);

  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    app.request('/api/memory/refine', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });

  let res = await post({ items: [] }, { 'x-test-no-tenant': '1' });
  assert.equal(res.status, 403, '无租户应 403');

  res = await post({});
  assert.equal(res.status, 400, '缺 items 应 400');

  res = await post({ items: 'not-array' });
  assert.equal(res.status, 400, 'items 非数组应 400');

  const tooMany = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, role: 'pending', type: 'preference', key: 'k', value: 'v' }));
  res = await post({ items: tooMany });
  assert.equal(res.status, 413, '超 50 条应 413');

  res = await post({ items: [{ id: 'not-int', role: 'pending', type: 'preference', key: 'k', value: 'v' }] });
  assert.equal(res.status, 400, 'id 非整数应 400');

  res = await post({ items: [{ id: 1, role: 'bogus', type: 'preference', key: 'k', value: 'v' }] });
  assert.equal(res.status, 400, 'role 非 pending/context 应 400');

  res = await post({ items: [{ id: 1, role: 'pending', type: 'preference', key: 'k', value: '' }] });
  assert.equal(res.status, 400, 'value 空字符串应 400');

  res = await post({
    items: [
      { id: 1, role: 'pending', type: 'preference', key: 'k', value: 'v' },
      { id: 1, role: 'context', type: 'preference', key: 'k2', value: 'v2' },
    ],
  });
  assert.equal(res.status, 400, '批次内 id 重复应 400');

  console.log('✓ 路由校验层（403/400×5/413）');
}

console.log('✅ memory-refine.test.ts 全部通过（核心解析五路 + 路由校验层）');
