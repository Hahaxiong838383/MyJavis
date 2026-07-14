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
      // R4 提炼追踪列（幂等迁移，ALTER TABLE ADD COLUMN + 捕获重复列错误——与 server 侧
      // storage.ts ensureXxxColumn() 同款容错模式）：NULL=待提炼，非 NULL=已提炼过的时间戳。
      try {
        await db.execute(`ALTER TABLE vault_memory ADD COLUMN refined_at INTEGER;`);
      } catch {
        /* 列已存在（已迁移过）：忽略 */
      }
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

// ===================== R4 提炼代理批次（docs/memory-architecture.md §4.4） =====================
// 与 apps/server/src/memory/refine-proxy.ts 的 RefineBatchItem/RefineDecision 类型同构，
// 字段一一对应；id 为本次批次内的临时整数编号（server 全程零落盘，防幻觉映射靠这批编号
// 而非真实 vault 主键，见 server 侧模块头注）。

export interface RefineBatchItem {
  id: number;
  role: 'pending' | 'context';
  type: string;
  key: string;
  value: string;
}

export interface RefineBatch {
  /** 待发给 /api/memory/refine 的完整批次（pending 在前，供 App 优先展示/调试）。 */
  items: RefineBatchItem[];
  /** 批次内整数编号 → 真实 vault_memory.id，落决策时反解用。 */
  idToVaultId: Map<number, string>;
  /** 批次内属于 pending 角色的编号集合（只应用这些编号上的决策，防越权碰 context）。 */
  pendingIds: Set<number>;
}

const REFINE_PENDING_LIMIT = 30;
const REFINE_CONTEXT_LIMIT = 20;

/** 取待提炼批次：pending=最早的未提炼条目，context=最近提炼过的条目（供 LLM 参考比对）。 */
export async function loadRefineBatch(): Promise<RefineBatch> {
  const db = await openVault();
  if (!db) return { items: [], idToVaultId: new Map(), pendingIds: new Set() };
  const pendingRows = await db.select<Array<Record<string, unknown>>>(
    `SELECT * FROM vault_memory WHERE refined_at IS NULL ORDER BY created_at ASC LIMIT $1`,
    [REFINE_PENDING_LIMIT],
  );
  const contextRows = await db.select<Array<Record<string, unknown>>>(
    `SELECT * FROM vault_memory WHERE refined_at IS NOT NULL ORDER BY refined_at DESC LIMIT $1`,
    [REFINE_CONTEXT_LIMIT],
  );
  const idToVaultId = new Map<number, string>();
  const pendingIds = new Set<number>();
  const items: RefineBatchItem[] = [];
  let seq = 1;
  for (const r of pendingRows) {
    const id = seq++;
    idToVaultId.set(id, String(r.id));
    pendingIds.add(id);
    items.push({ id, role: 'pending', type: String(r.type), key: String(r.key), value: String(r.value) });
  }
  for (const r of contextRows) {
    const id = seq++;
    idToVaultId.set(id, String(r.id));
    items.push({ id, role: 'context', type: String(r.type), key: String(r.key), value: String(r.value) });
  }
  return { items, idToVaultId, pendingIds };
}

export interface RefineDecision {
  id: number;
  action: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';
  mergeWithId?: number;
  value?: string;
}

/**
 * 按 server 决策落地本机 vault：
 * - ADD/NONE：原样保留，只打标已提炼（refined_at=now）
 * - UPDATE：把 value 写入 mergeWithId 引用的目标行（该行也顺带打标已提炼），当前 pending 行
 *   视为已被合并，直接删除（避免同一事实留两行）
 * - DELETE：pending 行与 mergeWithId 目标语义重复，直接删除该 pending 行
 * 只处理 batch.pendingIds 范围内的决策（防 server/LLM 越权碰 context 行）；
 * 引用不到真实 vault id（幻觉编号）的决策整条跳过。
 */
export async function applyRefineDecisions(batch: RefineBatch, decisions: RefineDecision[]): Promise<number> {
  const db = await openVault();
  if (!db) return 0;
  const now = Date.now();
  let applied = 0;
  for (const d of decisions) {
    if (!batch.pendingIds.has(d.id)) continue;
    const vaultId = batch.idToVaultId.get(d.id);
    if (!vaultId) continue;
    if (d.action === 'DELETE') {
      await db.execute(`DELETE FROM vault_memory WHERE id = $1`, [vaultId]);
    } else if (d.action === 'UPDATE' && d.mergeWithId !== undefined) {
      const targetVaultId = batch.idToVaultId.get(d.mergeWithId);
      if (targetVaultId && d.value?.trim()) {
        await db.execute(`UPDATE vault_memory SET value = $1, refined_at = $2 WHERE id = $3`, [
          d.value.trim().slice(0, 200),
          now,
          targetVaultId,
        ]);
      }
      await db.execute(`DELETE FROM vault_memory WHERE id = $1`, [vaultId]);
    } else {
      // ADD / NONE：原样保留，只打标已提炼
      await db.execute(`UPDATE vault_memory SET refined_at = $1 WHERE id = $2`, [now, vaultId]);
    }
    applied += 1;
  }
  return applied;
}
