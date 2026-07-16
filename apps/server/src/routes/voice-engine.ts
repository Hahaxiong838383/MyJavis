/**
 * 自研语音链路接入（双引擎对比实验，2026-07-15）。
 *
 * App 切「自研」引擎起会话前，经此端点拿一次性接入凭据：
 *   POST /api/voice-engine/token → { ok, url, token, roomName }
 * 一次一房（自研侧挂断即删房、重连必新房），roomName 与火山 roomId 体系互不相干——
 * App 侧自研模式对周边（声纹/vault/报幕）暴露 roomId=null，让火山会话专属能力自然静默。
 * 凭据 env（SELF_VOICE_URL/API_KEY/API_SECRET）齐备才启用，缺失=503（App 据此提示未开通）。
 */
import { Hono } from 'hono';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { config } from '../config.js';
import { effectiveTenant, type AppEnv } from '../tenant/context.js';

export const voiceEngineRoute = new Hono<AppEnv>();

voiceEngineRoute.post('/token', async (c) => {
  const sv = config.selfVoice;
  if (!sv.url || !sv.apiKey || !sv.apiSecret) {
    return c.json({ ok: false, error: '自研链路未在服务端开通' }, 503);
  }
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: '未授权' }, 401);

  const tid = tenant.id.slice(0, 8);
  const roomName = `jv-${tid}-${Date.now().toString(36)}`;
  const at = new AccessToken(sv.apiKey, sv.apiSecret, { identity: `jv-${tid}`, ttl: '2h' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  // explicit dispatch：进房即派遣自研 agent（worker 注册了 agent_name，不带这段 agent 不来）。
  // metadata=A 方案共脑指引（2026-07-16）：worker 据此把 LLM 指回本 server 的 CustomLLM 端点
  // （session/tenant 走 query），记忆/人设/视觉融合与 benchmark 同源。仅非敏感字段——
  // roomConfig 在 JWT payload 里客户端可解码，绝不放 key/secret（端点鉴权 key 在 worker 侧 env）。
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: sv.agentName,
        metadata: JSON.stringify({ myjavis: { session: roomName, tenant: tenant.id } }),
      }),
    ],
  });
  const token = await at.toJwt();
  console.log(`[voice-engine] token issued tenant=${tid} room=${roomName}`);
  return c.json({ ok: true, url: sv.url, token, roomName });
});
