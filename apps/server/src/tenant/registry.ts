/**
 * 租户（内测多用户隔离，≤10 人规模的轻量版）。
 *
 * - token = 邀请码（jv-xxxxx-xxxxx，~50bit 随机），App 首启输入激活；一人一码可单独吊销。
 * - persona_extra = 用户自配 prompt 段，**叠加**在锁定基座之后（语音输出规范/安全基线不可覆盖）。
 * - user_title = Javis 对用户的默认称呼（声纹未识别时兜底；识别命中用声纹显示名）。
 * - 不做：注册流/密码/计费（内测不需要）。管理走 admin API（JAVIS_API_KEY）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { storage } from '../memory/index.js';

export interface Tenant {
  id: string;
  name: string;
  token: string;
  personaExtra?: string;
  userTitle?: string;
  /** R3.5 单人模式（默认开）：该租户全部记忆归租户默认 owner，无需声纹识别即可用。见 docs/IMPL-R3.5-记忆体验修复-PROMPT.md §2.1。 */
  soloMode: boolean;
  status: 'active' | 'revoked';
  createdAt: number;
  updatedAt: number;
}

const db = storage.db;
db.exec(`
  CREATE TABLE IF NOT EXISTS tenant (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token         TEXT NOT NULL UNIQUE,
    persona_extra TEXT,
    user_title    TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_token ON tenant(token);
`);
// R3.5 老库迁移：加 solo_mode 列（沿用 storage.ts 的 ensureXxx 容错迁移模式）
try {
  db.exec(`ALTER TABLE tenant ADD COLUMN solo_mode INTEGER NOT NULL DEFAULT 1;`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!/duplicate column name/i.test(message)) throw err;
}

/** 邀请码：jv-xxxxx-xxxxx（base32 小写，避开易混字符）。 */
export function newInviteToken(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去 i/l/o/0/1
  const pick = (n: number): string =>
    Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]!).join('');
  return `jv-${pick(5)}-${pick(5)}`;
}

export function createTenant(name: string): Tenant {
  const now = Date.now();
  const tenant: Tenant = {
    id: `tn_${randomUUID().slice(0, 8)}`,
    name,
    token: newInviteToken(),
    soloMode: true,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO tenant (id, name, token, persona_extra, user_title, solo_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 1, 'active', ?, ?)`,
  ).run(tenant.id, tenant.name, tenant.token, tenant.createdAt, tenant.updatedAt);
  return tenant;
}

export function findTenantByToken(token: string): Tenant | undefined {
  const row = db.prepare("SELECT * FROM tenant WHERE token = ? AND status = 'active'").get(token) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTenant(row) : undefined;
}

export function getTenant(id: string): Tenant | undefined {
  const row = db.prepare('SELECT * FROM tenant WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTenant(row) : undefined;
}

export function listTenants(): Tenant[] {
  const rows = db.prepare('SELECT * FROM tenant ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
  return rows.map(rowToTenant);
}

export function updateTenantConfig(
  id: string,
  patch: { name?: string; personaExtra?: string; userTitle?: string; soloMode?: boolean; status?: 'active' | 'revoked' },
): Tenant | undefined {
  const current = getTenant(id);
  if (!current) return undefined;
  db.prepare(
    `UPDATE tenant SET name = ?, persona_extra = ?, user_title = ?, solo_mode = ?, status = ?, updated_at = ? WHERE id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.personaExtra !== undefined ? patch.personaExtra : (current.personaExtra ?? null),
    patch.userTitle !== undefined ? patch.userTitle : (current.userTitle ?? null),
    (patch.soloMode !== undefined ? patch.soloMode : current.soloMode) ? 1 : 0,
    patch.status ?? current.status,
    Date.now(),
    id,
  );
  return getTenant(id);
}

function rowToTenant(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id),
    name: String(row.name),
    token: String(row.token),
    personaExtra: row.persona_extra == null ? undefined : String(row.persona_extra),
    userTitle: row.user_title == null ? undefined : String(row.user_title),
    soloMode: Number(row.solo_mode ?? 1) === 1,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
