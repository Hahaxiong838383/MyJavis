/**
 * 本机隐私记忆 Vault（R2，docs/memory-architecture.md §4）。
 *
 * 存储：tauri-plugin-sql（SQLite 单文件，App 数据目录 vault.db；打开后调 Rust
 * `vault_harden` 把文件权限收到 0600，静态加密依赖 FileVault，SQLCipher 后置）。
 * schema 与云端 memory_item 同构（分层/双时间轴/salience 素材/向量列全预留），
 * 两层记忆本体论一套类型——R3/R4 的晋升巩固逻辑落地时本机零迁移。
 * 仅在 Tauri 环境可用（纯浏览器 dev 下 openVault 返回 null，功能静默降级）。
 */
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface VaultMemory {
  id: string;
  ownerId: string;
  type: string;
  key: string;
  value: string;
  sourceSpan: string;
  status: string;
  confidence: number;
  sensitivity: string; // 分类命中依据 type|key|keyword（治理面板改判素材）
  layer: string; // working|episodic|semantic|profile（R1 类型先行，R4 启用晋升）
  occurredAt: number | null;
  createdAt: number;
  heldAt: number;
}

type SqlDatabase = {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
  select: <T>(sql: string, params?: unknown[]) => Promise<T>;
};

let dbPromise: Promise<SqlDatabase | null> | null = null;

export function openVault(): Promise<SqlDatabase | null> {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (!isTauri()) return null;
      const { default: Database } = await import('@tauri-apps/plugin-sql');
      const db = (await Database.load('sqlite:vault.db')) as unknown as SqlDatabase;
      await db.execute(`
        CREATE TABLE IF NOT EXISTS vault_memory (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          type TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          source_span TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'committed',
          confidence REAL NOT NULL DEFAULT 1,
          sensitivity TEXT NOT NULL DEFAULT '',
          layer TEXT NOT NULL DEFAULT 'semantic',
          occurred_at INTEGER,
          created_at INTEGER NOT NULL,
          held_at INTEGER NOT NULL,
          reinforcement_count INTEGER NOT NULL DEFAULT 0,
          last_recalled_at INTEGER,
          valid_at INTEGER,
          invalid_at INTEGER,
          expired_at INTEGER,
          embedding BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_vault_owner ON vault_memory(owner_id, created_at DESC);
      `);
      // 权限收紧到 0600（首次建库后；失败不阻塞——FileVault 兜底）
      invoke('vault_harden').catch(() => {});
      return db;
    })();
  }
  return dbPromise;
}

/** 云端 MemoryItem（pending 拉取形态）→ vault 行。幂等 upsert。 */
export async function upsertVaultMemories(
  entries: Array<{
    memory: {
      id: string;
      ownerId: string;
      type: string;
      content: { key: string; value: string };
      sourceSpan?: string;
      status: string;
      confidence: number;
      createdAt: number;
    };
    heldAt: number;
    classify?: { reason?: string; hit?: string };
  }>,
): Promise<number> {
  const db = await openVault();
  if (!db || entries.length === 0) return 0;
  for (const entry of entries) {
    const m = entry.memory;
    await db.execute(
      `INSERT INTO vault_memory (id, owner_id, type, key, value, source_span, status, confidence, sensitivity, layer, created_at, held_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(id) DO UPDATE SET value=excluded.value, status=excluded.status, confidence=excluded.confidence`,
      [
        m.id, m.ownerId, m.type, m.content.key, m.content.value, m.sourceSpan ?? '',
        m.status, m.confidence,
        entry.classify ? `${entry.classify.reason ?? ''}:${entry.classify.hit ?? ''}` : '',
        m.type === 'event' ? 'episodic' : 'semantic',
        m.createdAt, entry.heldAt,
      ],
    );
  }
  return entries.length;
}

export async function listVaultMemories(limit = 200): Promise<VaultMemory[]> {
  const db = await openVault();
  if (!db) return [];
  const rows = await db.select<Array<Record<string, unknown>>>(
    `SELECT * FROM vault_memory ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id), ownerId: String(r.owner_id), type: String(r.type),
    key: String(r.key), value: String(r.value), sourceSpan: String(r.source_span ?? ''),
    status: String(r.status), confidence: Number(r.confidence), sensitivity: String(r.sensitivity ?? ''),
    layer: String(r.layer ?? 'semantic'),
    occurredAt: r.occurred_at == null ? null : Number(r.occurred_at),
    createdAt: Number(r.created_at), heldAt: Number(r.held_at),
  }));
}

export async function deleteVaultMemory(id: string): Promise<void> {
  const db = await openVault();
  if (!db) return;
  await db.execute(`DELETE FROM vault_memory WHERE id = $1`, [id]);
}

/** 通话上行形态：text = key+value+原话（与云端 toRecallDoc 同构拼法，检索面一致）。 */
export async function vaultItemsForSession(): Promise<
  Array<{ id: string; ownerId: string; text: string; type: string; createdAt: number }>
> {
  const memories = await listVaultMemories(100);
  return memories.map((m) => ({
    id: m.id,
    ownerId: m.ownerId,
    text: [m.key, m.value, m.sourceSpan].filter(Boolean).join(' '),
    type: m.type,
    createdAt: m.createdAt,
  }));
}
