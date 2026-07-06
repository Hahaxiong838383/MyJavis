/**
 * 租户上下文（Hono Variables）与解析工具。
 *
 * 鉴权模型（内测轻量版）：
 * - X-Javis-Key = 租户邀请码 → 绑定该租户；
 * - X-Javis-Key = JAVIS_API_KEY（env）→ admin：可 ?tenantId= 指定操作租户，
 *   不指定则回落 DEFAULT_ADMIN_TENANT（兼容川哥现有 App 平滑过渡）。
 */
import type { Context } from 'hono';
import { getTenant, type Tenant } from './registry.js';

export interface AppEnv {
  Variables: {
    tenant: Tenant | null;
    isAdmin: boolean;
  };
}

/** 业务端点取生效租户：普通用户=自己的租户；admin=query 指定或默认租户；都没有=null。 */
export function effectiveTenant(c: Context<AppEnv>): Tenant | null {
  const own = c.get('tenant');
  if (own) return own;
  if (!c.get('isAdmin')) return null;
  const specified = c.req.query('tenantId')?.trim() || process.env.DEFAULT_ADMIN_TENANT;
  return specified ? (getTenant(specified) ?? null) : null;
}
