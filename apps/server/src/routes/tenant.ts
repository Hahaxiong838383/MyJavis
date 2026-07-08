/**
 * 租户管理（批次A）：
 *   /api/tenant/*  admin only —— 建租户发码 / 列表 / 吊销 / 改名
 *   /api/me/*      租户自身  —— 激活校验（App 首启验码）+ 自配 persona/称呼
 */
import { Hono } from 'hono';
import { createTenant, listTenants, updateTenantConfig, getTenant } from '../tenant/registry.js';
import { bumpSyncVersion } from '../sync/versions.js';
import type { AppEnv } from '../tenant/context.js';

const tenantRoute = new Hono<AppEnv>();

tenantRoute.use('*', async (c, next) => {
  if (!c.get('isAdmin')) return c.json({ ok: false, error: 'admin only' }, 403);
  await next();
});

/** 建租户（返回邀请码，只在这里完整展示一次性抄走）。body: { name } */
tenantRoute.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return c.json({ ok: false, error: 'name 必填' }, 400);
  const tenant = createTenant(name);
  console.log(`[tenant] created id=${tenant.id} name=${name}`);
  return c.json({ ok: true, tenant });
});

tenantRoute.get('/', (c) => {
  // 列表不回 token 明文（半掩码）；完整 token 只在创建响应里给
  const tenants = listTenants().map((t) => ({ ...t, token: `${t.token.slice(0, 8)}****` }));
  return c.json({ ok: true, tenants });
});

tenantRoute.post('/revoke', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { tenantId?: string } | null;
  if (!body?.tenantId) return c.json({ ok: false, error: 'tenantId 必填' }, 400);
  const t = updateTenantConfig(body.tenantId, { status: 'revoked' });
  if (!t) return c.json({ ok: false, error: '租户不存在' }, 404);
  console.log(`[tenant] revoked id=${t.id} name=${t.name}`);
  return c.json({ ok: true });
});

tenantRoute.post('/rename', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { tenantId?: string; name?: string } | null;
  if (!body?.tenantId || !body.name?.trim()) return c.json({ ok: false, error: 'tenantId + name 必填' }, 400);
  const t = updateTenantConfig(body.tenantId, { name: body.name.trim() });
  if (!t) return c.json({ ok: false, error: '租户不存在' }, 404);
  return c.json({ ok: true, tenant: { ...t, token: `${t.token.slice(0, 8)}****` } });
});

// ---------------- /api/me ----------------

const meRoute = new Hono<AppEnv>();

const MAX_PERSONA_EXTRA = 2000;
const MAX_TITLE = 16;

/** App 首启激活校验 + 拉配置（普通租户回自己；admin 回默认租户便于调试）。 */
meRoute.get('/config', (c) => {
  const tenant = c.get('tenant') ?? (c.get('isAdmin') ? adminFallbackTenant(c.req.query('tenantId')) : null);
  if (!tenant) return c.json({ ok: false, error: '无租户上下文' }, 404);
  return c.json({
    ok: true,
    me: {
      tenantId: tenant.id,
      name: tenant.name,
      personaExtra: tenant.personaExtra ?? '',
      userTitle: tenant.userTitle ?? '',
      soloMode: tenant.soloMode,
    },
  });
});

/** 自配 persona/称呼/单人模式（叠加段，基座与安全基线 server 端锁定不可覆盖）。 */
meRoute.put('/config', async (c) => {
  const tenant = c.get('tenant') ?? (c.get('isAdmin') ? adminFallbackTenant(c.req.query('tenantId')) : null);
  if (!tenant) return c.json({ ok: false, error: '无租户上下文' }, 404);
  const body = (await c.req.json().catch(() => null)) as
    | { personaExtra?: string; userTitle?: string; soloMode?: boolean }
    | null;
  if (!body) return c.json({ ok: false, error: 'invalid json' }, 400);
  const personaExtra = body.personaExtra !== undefined ? String(body.personaExtra).slice(0, MAX_PERSONA_EXTRA) : undefined;
  const userTitle = body.userTitle !== undefined ? String(body.userTitle).trim().slice(0, MAX_TITLE) : undefined;
  const soloMode = typeof body.soloMode === 'boolean' ? body.soloMode : undefined;
  const updated = updateTenantConfig(tenant.id, { personaExtra, userTitle, soloMode });
  if (soloMode !== undefined) bumpSyncVersion(tenant.id, 'memory'); // 单人模式切换影响 owner 归属，面板需感知
  console.log(
    `[tenant] config updated id=${tenant.id} personaExtra=${personaExtra?.length ?? '-'}字 title="${userTitle ?? '-'}" soloMode=${soloMode ?? '-'}`,
  );
  return c.json({
    ok: true,
    me: {
      tenantId: updated!.id,
      name: updated!.name,
      personaExtra: updated!.personaExtra ?? '',
      userTitle: updated!.userTitle ?? '',
      soloMode: updated!.soloMode,
    },
  });
});

function adminFallbackTenant(specified?: string) {
  const id = specified?.trim() || process.env.DEFAULT_ADMIN_TENANT;
  return id ? (getTenant(id) ?? null) : null;
}

export { tenantRoute, meRoute };
