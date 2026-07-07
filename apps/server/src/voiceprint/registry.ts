/**
 * 声纹 registry：火山声纹 ID ↔ AudioName(ASCII slug) ↔ 显示名 ↔ 记忆 ownerId 的本地映射。
 *
 * - AudioName 用 ASCII slug（jv_xxxxxxxx）：火山把它拼进 LLM 可见的说话人标签，
 *   中文名合法性未验证（文档示例全英文），slug 最稳；显示名（"川哥"）只存本地。
 * - ownerId 用 identity 层同一 hash 函数派生，保证声纹 → 记忆归属一致。
 * - 表建在 memory 同一 SQLite 文件（声纹本就是身份域数据，与 owner 表同库便于关联）。
 * - 多租户（2026-07-03 批次A）：每条声纹归属一个 tenant；"3 人上限"是火山单通话限制，
 *   按租户各算各的（每局 StartVoiceChat 只带该租户的 ≤3 个声纹）。
 */
import { randomBytes } from 'node:crypto';
import { storage } from '../memory/index.js';
import { ownerIdFromVoiceprint } from '../memory/identity/index.js';
import { bumpSyncVersion } from '../sync/versions.js';

export interface VoiceprintRecord {
  voiceprintId: string;
  tenantId: string;
  audioName: string;
  displayName: string;
  ownerId: string;
  metaInfo?: string;
  createdAt: number;
  updatedAt: number;
}

export const MAX_ACTIVE_VOICEPRINTS = 3; // 火山声纹识别 Mode=2 单通话上限（PDF 页 7484）

const db = storage.db;
db.exec(`
  CREATE TABLE IF NOT EXISTS voiceprint (
    voiceprint_id TEXT PRIMARY KEY,
    audio_name    TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    meta_info     TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voiceprint_owner ON voiceprint(owner_id);
`);
// 老库迁移：加 tenant_id 列（存量行由 scripts/migrate-tenant.ts 归给首个租户）
const hasTenantCol = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('voiceprint') WHERE name='tenant_id'`).get() as { n: number }).n > 0;
if (!hasTenantCol) {
  db.exec(`ALTER TABLE voiceprint ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_voiceprint_tenant ON voiceprint(tenant_id);`);

export function newAudioName(): string {
  return `jv_${randomBytes(4).toString('hex')}`;
}

export function saveVoiceprint(args: {
  voiceprintId: string;
  tenantId: string;
  audioName: string;
  displayName: string;
  metaInfo?: string;
}): VoiceprintRecord {
  const now = Date.now();
  const record: VoiceprintRecord = {
    voiceprintId: args.voiceprintId,
    tenantId: args.tenantId,
    audioName: args.audioName,
    displayName: args.displayName,
    ownerId: ownerIdFromVoiceprint(args.voiceprintId),
    metaInfo: args.metaInfo,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO voiceprint (voiceprint_id, tenant_id, audio_name, display_name, owner_id, meta_info, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(voiceprint_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       audio_name = excluded.audio_name,
       display_name = excluded.display_name,
       meta_info = excluded.meta_info,
       updated_at = excluded.updated_at`,
  ).run(
    record.voiceprintId,
    record.tenantId,
    record.audioName,
    record.displayName,
    record.ownerId,
    record.metaInfo ?? null,
    record.createdAt,
    record.updatedAt,
  );
  bumpSyncVersion(record.tenantId, 'voiceprint');
  return record;
}

export function listActiveVoiceprints(tenantId: string): VoiceprintRecord[] {
  const rows = db
    .prepare('SELECT * FROM voiceprint WHERE tenant_id = ? ORDER BY created_at ASC')
    .all(tenantId) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

/** AudioName 全局唯一（我们生成的随机 slug），标签反查不需要租户上下文；返回记录含归属租户。 */
export function findByAudioName(audioName: string): VoiceprintRecord | undefined {
  const row = db.prepare('SELECT * FROM voiceprint WHERE audio_name = ?').get(audioName) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function findByDisplayName(tenantId: string, displayName: string): VoiceprintRecord | undefined {
  const row = db
    .prepare('SELECT * FROM voiceprint WHERE tenant_id = ? AND display_name = ? ORDER BY created_at DESC')
    .get(tenantId, displayName) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : undefined;
}

/** 记忆治理的归属校验：owner 是否由该租户的某条声纹派生。 */
export function tenantOwnsOwner(tenantId: string, ownerId: string): boolean {
  const row = db.prepare('SELECT 1 AS x FROM voiceprint WHERE tenant_id = ? AND owner_id = ?').get(tenantId, ownerId);
  return Boolean(row);
}

export function getVoiceprint(voiceprintId: string): VoiceprintRecord | undefined {
  const row = db.prepare('SELECT * FROM voiceprint WHERE voiceprint_id = ?').get(voiceprintId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function removeVoiceprint(voiceprintId: string): boolean {
  const record = getVoiceprint(voiceprintId);
  const res = db.prepare('DELETE FROM voiceprint WHERE voiceprint_id = ?').run(voiceprintId);
  if (Number(res.changes) > 0) bumpSyncVersion(record?.tenantId, 'voiceprint');
  return Number(res.changes) > 0;
}

/** 改显示名（只动本地映射；火山侧 AudioName slug 与声纹绑定不变，识别链路即时用新名）。 */
export function renameVoiceprint(voiceprintId: string, displayName: string): VoiceprintRecord | undefined {
  const res = db
    .prepare('UPDATE voiceprint SET display_name = ?, updated_at = ? WHERE voiceprint_id = ?')
    .run(displayName, Date.now(), voiceprintId);
  if (Number(res.changes) === 0) return undefined;
  const record = getVoiceprint(voiceprintId);
  bumpSyncVersion(record?.tenantId, 'voiceprint');
  return record;
}

function rowToRecord(row: Record<string, unknown>): VoiceprintRecord {
  return {
    voiceprintId: String(row.voiceprint_id),
    tenantId: String(row.tenant_id ?? ''),
    audioName: String(row.audio_name),
    displayName: String(row.display_name),
    ownerId: String(row.owner_id),
    metaInfo: row.meta_info == null ? undefined : String(row.meta_info),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
