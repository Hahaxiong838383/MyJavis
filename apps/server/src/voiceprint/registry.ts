/**
 * 声纹 registry：火山声纹 ID ↔ AudioName(ASCII slug) ↔ 显示名 ↔ 记忆 ownerId 的本地映射。
 *
 * - AudioName 用 ASCII slug（jv_xxxxxxxx）：火山把它拼进 LLM 可见的说话人标签，
 *   中文名合法性未验证（文档示例全英文），slug 最稳；显示名（"川哥"）只存本地。
 * - ownerId 用 identity 层同一 hash 函数派生，保证声纹 → 记忆归属一致。
 * - 表建在 memory 同一 SQLite 文件（声纹本就是身份域数据，与 owner 表同库便于关联）。
 */
import { randomBytes } from 'node:crypto';
import { storage } from '../memory/index.js';
import { ownerIdFromVoiceprint } from '../memory/identity/index.js';

export interface VoiceprintRecord {
  voiceprintId: string;
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

export function newAudioName(): string {
  return `jv_${randomBytes(4).toString('hex')}`;
}

export function saveVoiceprint(args: {
  voiceprintId: string;
  audioName: string;
  displayName: string;
  metaInfo?: string;
}): VoiceprintRecord {
  const now = Date.now();
  const record: VoiceprintRecord = {
    voiceprintId: args.voiceprintId,
    audioName: args.audioName,
    displayName: args.displayName,
    ownerId: ownerIdFromVoiceprint(args.voiceprintId),
    metaInfo: args.metaInfo,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO voiceprint (voiceprint_id, audio_name, display_name, owner_id, meta_info, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(voiceprint_id) DO UPDATE SET
       audio_name = excluded.audio_name,
       display_name = excluded.display_name,
       meta_info = excluded.meta_info,
       updated_at = excluded.updated_at`,
  ).run(
    record.voiceprintId,
    record.audioName,
    record.displayName,
    record.ownerId,
    record.metaInfo ?? null,
    record.createdAt,
    record.updatedAt,
  );
  return record;
}

export function listActiveVoiceprints(): VoiceprintRecord[] {
  const rows = db.prepare('SELECT * FROM voiceprint ORDER BY created_at ASC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToRecord);
}

export function findByAudioName(audioName: string): VoiceprintRecord | undefined {
  const row = db.prepare('SELECT * FROM voiceprint WHERE audio_name = ?').get(audioName) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function findByDisplayName(displayName: string): VoiceprintRecord | undefined {
  const row = db.prepare('SELECT * FROM voiceprint WHERE display_name = ? ORDER BY created_at DESC').get(
    displayName,
  ) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function removeVoiceprint(voiceprintId: string): boolean {
  const res = db.prepare('DELETE FROM voiceprint WHERE voiceprint_id = ?').run(voiceprintId);
  return Number(res.changes) > 0;
}

/** 改显示名（只动本地映射；火山侧 AudioName slug 与声纹绑定不变，识别链路即时用新名）。 */
export function renameVoiceprint(voiceprintId: string, displayName: string): VoiceprintRecord | undefined {
  const res = db
    .prepare('UPDATE voiceprint SET display_name = ?, updated_at = ? WHERE voiceprint_id = ?')
    .run(displayName, Date.now(), voiceprintId);
  if (Number(res.changes) === 0) return undefined;
  const row = db.prepare('SELECT * FROM voiceprint WHERE voiceprint_id = ?').get(voiceprintId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

function rowToRecord(row: Record<string, unknown>): VoiceprintRecord {
  return {
    voiceprintId: String(row.voiceprint_id),
    audioName: String(row.audio_name),
    displayName: String(row.display_name),
    ownerId: String(row.owner_id),
    metaInfo: row.meta_info == null ? undefined : String(row.meta_info),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
