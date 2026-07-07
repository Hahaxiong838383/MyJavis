/**
 * R2 隐私记忆通道（docs/memory-architecture.md §4.2/§4.3）。
 *
 * - GET  /pending          App 轮询待拉取的隐私记忆（拉取不删除）
 * - POST /ack {ids}        App 落本机 vault 成功后确认 → server 即焚
 * - POST /session-context  通话开始时 App 上行本机 vault 记忆 → server 内存持有，
 *                          recall 时并进候选统一打分；房间结束/TTL 过期即弃（云端零落盘）
 * - DELETE /session-context/:roomId  通话结束显式清理
 *
 * 鉴权：X-Javis-Key 租户中间件（同 reminders 模式，走 effectiveTenant）。
 * 红线：本文件所有日志/审计只记条数，绝不记内容。
 */
import { Hono } from 'hono';
import { ackPrivacyItems, listPendingPrivacy } from '../privacy/hold-store.js';
import { clearSessionContext, setSessionContext } from '../privacy/session-context.js';
import type { AppEnv } from '../tenant/context.js';

const privacyRoute = new Hono<AppEnv>();

privacyRoute.get('/pending', (c) => {
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const pending = listPendingPrivacy(tenant.id);
  return c.json({
    ok: true,
    items: pending.map((entry) => ({
      memory: entry.item,
      heldAt: entry.heldAt,
      classify: entry.classify,
    })),
  });
});

privacyRoute.post('/ack', async (c) => {
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { ids?: string[] } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
  if (ids.length === 0) return c.json({ ok: false, error: 'ids 必填' }, 400);
  const burned = ackPrivacyItems(tenant.id, ids);
  console.log(`[privacy] tenant=${tenant.id} ack burned=${burned}`);
  return c.json({ ok: true, burned });
});

privacyRoute.post('/session-context', async (c) => {
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    roomId?: string;
    items?: Array<{ id?: string; ownerId?: string; text?: string; type?: string; createdAt?: number }>;
  } | null;
  const roomId = body?.roomId?.trim();
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  const items = (Array.isArray(body?.items) ? body.items : [])
    .filter(
      (item) =>
        typeof item?.id === 'string' &&
        typeof item?.ownerId === 'string' &&
        typeof item?.text === 'string' &&
        item.text.trim(),
    )
    .map((item) => ({
      id: item.id!,
      ownerId: item.ownerId!,
      text: item.text!,
      type: typeof item.type === 'string' ? item.type : 'unknown',
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    }));
  const accepted = setSessionContext(tenant.id, roomId, items);
  console.log(`[privacy] tenant=${tenant.id} room=${roomId} session-context accepted=${accepted}`);
  return c.json({ ok: true, accepted });
});

privacyRoute.delete('/session-context/:roomId', (c) => {
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const cleared = clearSessionContext(tenant.id, c.req.param('roomId'));
  return c.json({ ok: true, cleared });
});

export { privacyRoute };
