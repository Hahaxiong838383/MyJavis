/**
 * voice-engine 路由单测：正常签发（解 JWT 验 grants/identity/TTL）/ 无租户 401 / env 缺失 503。
 * 跑法：npm run test:voice-engine
 */
process.env.MYJAVIS_MEMORY_DB = ':memory:';
process.env.SELF_VOICE_URL = 'wss://voice.example.test';
process.env.SELF_VOICE_API_KEY = 'testkey';
process.env.SELF_VOICE_API_SECRET = 'testsecret-of-sufficient-length-000';

import assert from 'node:assert/strict';
import { Hono } from 'hono';

const { voiceEngineRoute } = await import('../src/routes/voice-engine.js');
const { createTenant } = await import('../src/tenant/registry.js');

const tenant = createTenant('自研链路测试租户');
const app = new Hono();
app.use('*', async (c, next) => {
  (c as unknown as { set: (k: string, v: unknown) => void }).set('tenant', c.req.header('x-test-no-tenant') ? null : tenant);
  (c as unknown as { set: (k: string, v: unknown) => void }).set('isAdmin', false);
  await next();
});
app.route('/api/voice-engine', voiceEngineRoute);

const requestToken = (headers: Record<string, string> = {}): Promise<Response> =>
  app.request('/api/voice-engine/token', { method: 'POST', headers });

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]!;
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

// ---------- 1. 正常签发 ----------
{
  const res = await requestToken();
  assert.equal(res.status, 200, '配置齐备+有租户 → 200');
  const data = (await res.json()) as { ok: boolean; url: string; token: string; roomName: string };
  assert.equal(data.ok, true);
  assert.equal(data.url, 'wss://voice.example.test', 'url 透传 env');
  assert.ok(data.roomName.startsWith(`jv-${tenant.id.slice(0, 8)}-`), '房名带租户前缀');

  const payload = decodeJwtPayload(data.token);
  assert.equal(payload.sub, `jv-${tenant.id.slice(0, 8)}`, 'identity=租户前缀');
  const video = payload.video as Record<string, unknown>;
  assert.equal(video.room, data.roomName, 'grant 绑定该房间');
  assert.equal(video.roomJoin, true, 'roomJoin grant');
  assert.equal(video.canPublish, true, 'canPublish grant');
  assert.equal(video.canSubscribe, true, 'canSubscribe grant');
  const ttl = (payload.exp as number) - (payload.nbf as number);
  assert.ok(ttl >= 7000 && ttl <= 7600, `TTL≈2h（实际 ${ttl}s）`);
  // explicit dispatch：roomConfig.agents 必须带 agentName，否则自研 worker 不派遣（生产实锤）
  const roomConfig = payload.roomConfig as { agents?: Array<{ agentName?: string; metadata?: string }> };
  assert.equal(roomConfig?.agents?.[0]?.agentName, 'realtime-voice-agent', 'roomConfig 指名派遣 agent');
  // A 方案共脑指引：metadata 带 session/tenant（非敏感），worker 据此接回 MyJavis 大脑
  const dispatchMeta = JSON.parse(roomConfig!.agents![0]!.metadata!) as { myjavis: { session: string; tenant: string } };
  assert.equal(dispatchMeta.myjavis.session, data.roomName, 'metadata.session=房名');
  assert.equal(dispatchMeta.myjavis.tenant, tenant.id, 'metadata.tenant=完整租户 id');
  assert.ok(!JSON.stringify(dispatchMeta).match(/key|secret/i), 'metadata 零敏感字段');
  console.log('✅ 1. 正常签发（JWT grants/identity/TTL/agent派遣/共脑metadata 全验）');
}

// ---------- 2. 一次一房：两次签发房名不同 ----------
{
  const a = (await (await requestToken()).json()) as { roomName: string };
  await new Promise((r) => setTimeout(r, 2));
  const b = (await (await requestToken()).json()) as { roomName: string };
  assert.notEqual(a.roomName, b.roomName, '每次签发新房名');
  console.log('✅ 2. 一次一房');
}

// ---------- 3. 无租户 401 ----------
{
  const res = await requestToken({ 'x-test-no-tenant': '1' });
  assert.equal(res.status, 401, '无租户 → 401');
  console.log('✅ 3. 无租户 401');
}

// ---------- 4. env 缺失 503（getter 动态读，运行时可摘除） ----------
{
  const saved = process.env.SELF_VOICE_URL;
  delete process.env.SELF_VOICE_URL;
  const res = await requestToken();
  assert.equal(res.status, 503, 'SELF_VOICE_URL 缺失 → 503');
  const data = (await res.json()) as { ok: boolean };
  assert.equal(data.ok, false);
  process.env.SELF_VOICE_URL = saved;
  console.log('✅ 4. env 缺失 503');
}

console.log('\nvoice-engine 4 组全过 ✅');
