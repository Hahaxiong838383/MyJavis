/**
 * UI 同步版本端点：前端 5s 轮询，纯内存零 DB 查询。
 * 版本变了=该域数据被任何路径（语音/面板/调度器/多端）改过，面板该刷新了。
 */
import { Hono } from 'hono';
import { effectiveTenant, type AppEnv } from '../tenant/context.js';
import { getSyncVersions } from '../sync/versions.js';

const syncRoute = new Hono<AppEnv>();

syncRoute.get('/versions', (c) => {
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);
  return c.json({ ok: true, versions: getSyncVersions(tenant.id) });
});

export { syncRoute };
