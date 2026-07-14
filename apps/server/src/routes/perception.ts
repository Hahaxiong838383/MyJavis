/**
 * Vision 感知 ingest API（V0，多租户，X-Javis-Key 中间件已在 index.ts 挂全局）。
 *
 *  POST /api/perception/ingest  采集端（vision-probe / 正式 sidecar）上报契约 v0.2 单条消息
 *  GET  /api/perception/state   当前租户 visionState 快照（验收/调试）
 *
 * 鉴权即绑定：租户 key 决定事件归属，探针无需第二套凭证。
 * 日志红线：只打 type/kind/seq 元数据，不打 payload 全文。
 */
import { Hono } from 'hono';
import { effectiveTenant, type AppEnv } from '../tenant/context.js';
import { config } from '../config.js';
import { validateEnvelope, ingestPerception, getVisionState } from '../perception/state.js';

const MAX_BODY_BYTES = 32 * 1024; // 契约 §1：单条 ≤ 32KB

const perceptionRoute = new Hono<AppEnv>();

perceptionRoute.post('/ingest', async (c) => {
  if (!config.vision.enabled) return c.json({ ok: false, error: 'vision disabled' }, 503);
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);

  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) return c.json({ ok: false, error: 'message too large' }, 413);
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }
  const v = validateEnvelope(msg);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);

  const accepted = ingestPerception(tenant.id, msg);
  if (msg.type !== 'heartbeat') {
    // 心跳 1Hz 不刷屏；hello/event/semantic 打一行元数据（不含 payload 内容）。
    const kind = msg.type === 'event' ? ` kind=${String((msg.payload as Record<string, unknown>).kind ?? '-')}` : '';
    console.log(`[perception] tenant=${tenant.id.slice(0, 8)} ${String(msg.type)}#${String(msg.seq)}${kind}${accepted ? '' : ' (stale-seq)'}`);
  }
  return c.json({ ok: true, accepted });
});

perceptionRoute.get('/state', (c) => {
  if (!config.vision.enabled) return c.json({ ok: false, error: 'vision disabled' }, 503);
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);
  return c.json({ ok: true, state: getVisionState(tenant.id) ?? null });
});

export { perceptionRoute };
