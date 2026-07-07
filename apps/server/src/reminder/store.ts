/**
 * reminder 持久层。与记忆库同一 SQLite 文件（WAL 多连接安全，备份脚本天然覆盖），
 * 但独立表/独立连接：提醒是调度语义（due/fired/ack），不是记忆语义，不塞 memory_item。
 *
 * 状态机：pending →(到点)→ fired →(App/RTC 接走)→ delivered
 *                                  ↘(30min 无人接)→ missed →(下次通话补报)→ delivered(makeup)
 *         pending →(语音/面板取消)→ cancelled
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type ReminderStatus = 'pending' | 'fired' | 'delivered' | 'missed' | 'cancelled';
export type DeliveredVia = 'rtc' | 'app' | 'makeup';

export interface Reminder {
  id: string;
  tenantId: string;
  ownerId?: string;
  speakerName?: string;
  content: string;
  dueAt: number;
  status: ReminderStatus;
  createdAt: number;
  firedAt?: number;
  deliveredAt?: number;
  deliveredVia?: DeliveredVia;
  roomId?: string;
}

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data/myjavis-memory.db');

interface Row {
  id: string;
  tenant_id: string;
  owner_id: string | null;
  speaker_name: string | null;
  content: string;
  due_at: number;
  status: ReminderStatus;
  created_at: number;
  fired_at: number | null;
  delivered_at: number | null;
  delivered_via: DeliveredVia | null;
  room_id: string | null;
}

function toReminder(r: Row): Reminder {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    ownerId: r.owner_id ?? undefined,
    speakerName: r.speaker_name ?? undefined,
    content: r.content,
    dueAt: r.due_at,
    status: r.status,
    createdAt: r.created_at,
    firedAt: r.fired_at ?? undefined,
    deliveredAt: r.delivered_at ?? undefined,
    deliveredVia: r.delivered_via ?? undefined,
    roomId: r.room_id ?? undefined,
  };
}

export class ReminderStore {
  readonly db: DatabaseSync;

  constructor(dbPath = process.env.MYJAVIS_MEMORY_DB ?? DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS reminder (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT,
        speaker_name TEXT,
        content TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','fired','delivered','missed','cancelled')),
        created_at INTEGER NOT NULL,
        fired_at INTEGER,
        delivered_at INTEGER,
        delivered_via TEXT,
        room_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reminder_due ON reminder(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_reminder_tenant ON reminder(tenant_id, status, due_at);
    `);
  }

  create(args: {
    tenantId: string;
    content: string;
    dueAt: number;
    ownerId?: string;
    speakerName?: string;
    roomId?: string;
  }): Reminder {
    const id = `rm_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO reminder (id, tenant_id, owner_id, speaker_name, content, due_at, status, created_at, room_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, args.tenantId, args.ownerId ?? null, args.speakerName ?? null, args.content, args.dueAt, now, args.roomId ?? null);
    return this.get(id)!;
  }

  get(id: string): Reminder | undefined {
    const row = this.db.prepare(`SELECT * FROM reminder WHERE id = ?`).get(id) as Row | undefined;
    return row ? toReminder(row) : undefined;
  }

  /** 调度器：到点的 pending。 */
  duePending(now: number): Reminder[] {
    const rows = this.db
      .prepare(`SELECT * FROM reminder WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT 50`)
      .all(now) as unknown as Row[];
    return rows.map(toReminder);
  }

  /** App 轮询：该租户已 fired 待接走的。 */
  firedForTenant(tenantId: string): Reminder[] {
    const rows = this.db
      .prepare(`SELECT * FROM reminder WHERE tenant_id = ? AND status = 'fired' ORDER BY due_at ASC LIMIT 10`)
      .all(tenantId) as unknown as Row[];
    return rows.map(toReminder);
  }

  /** 补报：该租户 missed 未送达的。 */
  missedForTenant(tenantId: string): Reminder[] {
    const rows = this.db
      .prepare(`SELECT * FROM reminder WHERE tenant_id = ? AND status = 'missed' ORDER BY due_at ASC LIMIT 10`)
      .all(tenantId) as unknown as Row[];
    return rows.map(toReminder);
  }

  /** 面板/查询：该租户即将到来的 pending（含 fired，用户视角都是"没完成的提醒"）。 */
  upcomingForTenant(tenantId: string, limit = 20): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminder WHERE tenant_id = ? AND status IN ('pending','fired')
         ORDER BY due_at ASC LIMIT ?`,
      )
      .all(tenantId, limit) as unknown as Row[];
    return rows.map(toReminder);
  }

  markFired(id: string): void {
    this.db.prepare(`UPDATE reminder SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'pending'`).run(Date.now(), id);
  }

  /** 送达（幂等：仅 fired/missed/pending 可转 delivered；返回是否真的转了）。 */
  markDelivered(id: string, via: DeliveredVia): boolean {
    const res = this.db
      .prepare(
        `UPDATE reminder SET status = 'delivered', delivered_at = ?, delivered_via = ?
         WHERE id = ? AND status IN ('pending','fired','missed')`,
      )
      .run(Date.now(), via, id);
    return Number(res.changes) > 0;
  }

  markMissed(id: string): void {
    this.db.prepare(`UPDATE reminder SET status = 'missed' WHERE id = ? AND status = 'fired'`).run(id);
  }

  /** fired 超时未被接走 → missed。返回转化条数。 */
  expireFired(olderThanMs: number, now: number): number {
    const res = this.db
      .prepare(`UPDATE reminder SET status = 'missed' WHERE status = 'fired' AND fired_at IS NOT NULL AND fired_at <= ?`)
      .run(now - olderThanMs);
    return Number(res.changes);
  }

  /** 取消（语音"取消提醒"/面板删除）。租户校验在调用方。 */
  cancel(id: string): boolean {
    const res = this.db
      .prepare(`UPDATE reminder SET status = 'cancelled' WHERE id = ? AND status IN ('pending','fired')`)
      .run(id);
    return Number(res.changes) > 0;
  }

  /** 语音"取消提醒"（不指名）：取消该租户最近创建的一条未触达提醒。 */
  cancelLatest(tenantId: string): Reminder | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM reminder WHERE tenant_id = ? AND status IN ('pending','fired')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tenantId) as Row | undefined;
    if (!row) return undefined;
    this.cancel(row.id);
    return { ...toReminder(row), status: 'cancelled' };
  }
}

let singleton: ReminderStore | undefined;
export function reminderStore(): ReminderStore {
  if (!singleton) singleton = new ReminderStore();
  return singleton;
}
