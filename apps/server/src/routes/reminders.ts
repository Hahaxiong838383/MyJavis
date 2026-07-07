/**
 * reminder REST API（多租户，X-Javis-Key 中间件已在 index.ts 挂全局）。
 *
 *  GET    /api/reminders/due     App 轮询：fired 待接走的（触达档2）
 *  POST   /api/reminders/:id/ack App 回执：已通知+念出 → delivered(app)
 *  GET    /api/reminders         面板列表：pending+fired
 *  DELETE /api/reminders/:id     面板删除（=取消）
 */
import { Hono } from 'hono';
import { effectiveTenant, type AppEnv } from '../tenant/context.js';
import { reminderStore } from '../reminder/store.js';

const remindersRoute = new Hono<AppEnv>();

remindersRoute.get('/due', (c) => {
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);
  const items = reminderStore().firedForTenant(tenant.id);
  return c.json({ ok: true, items });
});

remindersRoute.post('/:id/ack', (c) => {
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);
  const id = c.req.param('id');
  const r = reminderStore().get(id);
  if (!r || r.tenantId !== tenant.id) return c.json({ ok: false, error: 'not found' }, 404);
  const changed = reminderStore().markDelivered(id, 'app');
  return c.json({ ok: true, changed });
});

remindersRoute.get('/', (c) => {
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);
  return c.json({ ok: true, items: reminderStore().upcomingForTenant(tenant.id) });
});

remindersRoute.delete('/:id', (c) => {
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);
  const id = c.req.param('id');
  const r = reminderStore().get(id);
  if (!r || r.tenantId !== tenant.id) return c.json({ ok: false, error: 'not found' }, 404);
  const cancelled = reminderStore().cancel(id);
  console.log(`[reminder] cancelled via api id=${id} tenant=${tenant.id}`);
  return c.json({ ok: true, cancelled });
});

export { remindersRoute };
