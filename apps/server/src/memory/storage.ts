import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  MemoryItem,
  MemoryStatus,
  MemoryType,
  SourceRole,
  SpeakerEvidence,
  SpeakerEvidenceState,
} from './types.js';

export interface EventLogRecord {
  id: string;
  roomId: string;
  asrSegmentId: string;
  speakerEvidenceId?: string;
  isFinal: boolean;
  sourceRole: SourceRole;
  utteranceText: string;
  utteranceStartTs: number;
  utteranceEndTs: number;
  llmResponseId?: string;
  ttsPlaybackStartTs?: number;
  ttsPlaybackEndTs?: number;
  interruptedAt?: number;
  heardByUser?: boolean;
  createdAt: number;
}

interface MemoryRow {
  id: string;
  owner_id: string;
  namespace: string;
  type: MemoryType;
  content_structured_json: string;
  source_role: SourceRole;
  source_span: string;
  asr_confidence: number | null;
  confidence: number;
  status: MemoryStatus;
  suspended?: number | null;
  valid_from: number | null;
  valid_until: number | null;
  ttl: number | null;
  created_at: number;
  last_reinforced: number | null;
  provenance_json: string;
  acl_json: string;
  speaker_evidence_id: string | null;
  event_id: string | null;
}

interface PrefSummaryRow {
  owner_id: string;
  dimension: string;
  current_value: string;
  active_conditions_json: string;
  updated_at: number;
}

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data/myjavis-memory.db');

export class SQLiteMemoryStorage {
  readonly db: DatabaseSync;

  constructor(dbPath = process.env.MYJAVIS_MEMORY_DB ?? DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.configure();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private configure(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 50;
      PRAGMA foreign_keys = ON;
    `);
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS speaker_evidence (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        voiceprint_id TEXT,
        voiceprint_name TEXT,
        score REAL,
        mode TEXT,
        raw_json TEXT NOT NULL,
        room_id TEXT NOT NULL,
        state TEXT NOT NULL,
        confidence REAL NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS owner (
        memory_owner_id TEXT PRIMARY KEY,
        display_name TEXT,
        state TEXT NOT NULL,
        bound_at INTEGER,
        evidence_history_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS event_log (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        asr_segment_id TEXT NOT NULL,
        speaker_evidence_id TEXT,
        is_final INTEGER NOT NULL,
        source_role TEXT NOT NULL,
        utterance_text TEXT NOT NULL,
        utterance_start_ts INTEGER NOT NULL,
        utterance_end_ts INTEGER NOT NULL,
        llm_response_id TEXT,
        tts_playback_start_ts INTEGER,
        tts_playback_end_ts INTEGER,
        interrupted_at INTEGER,
        heard_by_user INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_item (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        type TEXT NOT NULL,
        content_structured_json TEXT NOT NULL,
        source_role TEXT NOT NULL,
        source_span TEXT NOT NULL,
        asr_confidence REAL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('committed','provisional','quarantine')),
        suspended INTEGER NOT NULL DEFAULT 0,
        valid_from INTEGER,
        valid_until INTEGER,
        ttl INTEGER,
        created_at INTEGER NOT NULL,
        last_reinforced INTEGER,
        provenance_json TEXT NOT NULL,
        acl_json TEXT NOT NULL,
        speaker_evidence_id TEXT,
        event_id TEXT
      );

      CREATE TABLE IF NOT EXISTS pref_summary (
        owner_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        current_value TEXT NOT NULL,
        active_conditions_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_id, dimension)
      );

      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        owner_id TEXT,
        kind TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        rationale TEXT NOT NULL,
        signal_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_owner_status_type_valid
        ON memory_item(owner_id, status, type, valid_until);
      CREATE INDEX IF NOT EXISTS idx_memory_owner_namespace_type
        ON memory_item(owner_id, namespace, type);
      CREATE INDEX IF NOT EXISTS idx_pref_summary_owner_dimension
        ON pref_summary(owner_id, dimension);
      CREATE INDEX IF NOT EXISTS idx_event_room_segment
        ON event_log(room_id, asr_segment_id);
      CREATE INDEX IF NOT EXISTS idx_speaker_voiceprint
        ON speaker_evidence(voiceprint_id, state, ts);
    `);
    this.ensureSuspendedColumn();
    this.db.exec(`
      DROP VIEW IF EXISTS hot_readable_memories;
      CREATE VIEW hot_readable_memories AS
        SELECT * FROM memory_item
        WHERE status IN ('committed', 'provisional')
          AND suspended = 0
          AND (valid_until IS NULL OR valid_until > (unixepoch('now') * 1000));

      DROP VIEW IF EXISTS quarantined_memories;
      CREATE VIEW quarantined_memories AS
        SELECT * FROM memory_item WHERE status = 'quarantine';
    `);
  }

  private ensureSuspendedColumn(): void {
    try {
      this.db.exec(`ALTER TABLE memory_item ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(message)) throw err;
    }
  }

  insertSpeakerEvidence(evidence: SpeakerEvidence): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO speaker_evidence
          (id, provider, voiceprint_id, voiceprint_name, score, mode, raw_json, room_id, state, confidence, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.id,
        evidence.provider,
        evidence.voiceprintId ?? null,
        evidence.voiceprintName ?? null,
        evidence.score ?? null,
        evidence.mode ?? null,
        JSON.stringify(evidence.rawPayload ?? null),
        evidence.roomId,
        evidence.state,
        evidence.confidence,
        evidence.ts,
      );
  }

  upsertOwner(ownerId: string, displayName: string | undefined, state: SpeakerEvidenceState, evidenceId: string): void {
    const existing = this.db
      .prepare(`SELECT evidence_history_json FROM owner WHERE memory_owner_id = ?`)
      .get(ownerId) as { evidence_history_json?: string } | undefined;
    const history = existing?.evidence_history_json ? (JSON.parse(existing.evidence_history_json) as string[]) : [];
    const nextHistory = [...new Set([...history, evidenceId])].slice(-20);
    this.db
      .prepare(
        `INSERT INTO owner(memory_owner_id, display_name, state, bound_at, evidence_history_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_owner_id) DO UPDATE SET
           display_name = excluded.display_name,
           state = excluded.state,
           evidence_history_json = excluded.evidence_history_json`,
      )
      .run(ownerId, displayName ?? ownerId, state, Date.now(), JSON.stringify(nextHistory));
  }

  insertEvent(record: EventLogRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event_log
          (id, room_id, asr_segment_id, speaker_evidence_id, is_final, source_role, utterance_text,
           utterance_start_ts, utterance_end_ts, llm_response_id, tts_playback_start_ts,
           tts_playback_end_ts, interrupted_at, heard_by_user, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.roomId,
        record.asrSegmentId,
        record.speakerEvidenceId ?? null,
        record.isFinal ? 1 : 0,
        record.sourceRole,
        record.utteranceText,
        record.utteranceStartTs,
        record.utteranceEndTs,
        record.llmResponseId ?? null,
        record.ttsPlaybackStartTs ?? null,
        record.ttsPlaybackEndTs ?? null,
        record.interruptedAt ?? null,
        record.heardByUser === undefined ? null : record.heardByUser ? 1 : 0,
        record.createdAt,
      );
  }

  getEvent(id: string): EventLogRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM event_log WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      roomId: String(row.room_id),
      asrSegmentId: String(row.asr_segment_id),
      speakerEvidenceId: nullableString(row.speaker_evidence_id),
      isFinal: Number(row.is_final) === 1,
      sourceRole: row.source_role as SourceRole,
      utteranceText: String(row.utterance_text),
      utteranceStartTs: Number(row.utterance_start_ts),
      utteranceEndTs: Number(row.utterance_end_ts),
      llmResponseId: nullableString(row.llm_response_id),
      ttsPlaybackStartTs: nullableNumber(row.tts_playback_start_ts),
      ttsPlaybackEndTs: nullableNumber(row.tts_playback_end_ts),
      interruptedAt: nullableNumber(row.interrupted_at),
      heardByUser: row.heard_by_user === null ? undefined : Number(row.heard_by_user) === 1,
      createdAt: Number(row.created_at),
    };
  }

  insertMemoryItem(item: MemoryItem): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_item
          (id, owner_id, namespace, type, content_structured_json, source_role, source_span,
           asr_confidence, confidence, status, suspended, valid_from, valid_until, ttl, created_at,
           last_reinforced, provenance_json, acl_json, speaker_evidence_id, event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.ownerId,
        item.namespace,
        item.type,
        JSON.stringify(item.content),
        item.sourceRole,
        item.sourceSpan,
        item.asrConfidence ?? null,
        item.confidence,
        item.status,
        item.suspended ? 1 : 0,
        item.validFrom ?? null,
        item.validUntil ?? null,
        item.ttl ?? null,
        item.createdAt,
        item.lastReinforced ?? null,
        JSON.stringify(item.provenance),
        JSON.stringify(item.acl),
        item.speakerEvidenceId ?? null,
        item.eventId ?? null,
      );
  }

  updateMemoryItem(item: MemoryItem): void {
    this.db
      .prepare(
        `UPDATE memory_item SET
          owner_id = ?, namespace = ?, type = ?, content_structured_json = ?, source_role = ?,
          source_span = ?, asr_confidence = ?, confidence = ?, status = ?, suspended = ?, valid_from = ?,
          valid_until = ?, ttl = ?, last_reinforced = ?, provenance_json = ?, acl_json = ?,
          speaker_evidence_id = ?, event_id = ?
         WHERE id = ?`,
      )
      .run(
        item.ownerId,
        item.namespace,
        item.type,
        JSON.stringify(item.content),
        item.sourceRole,
        item.sourceSpan,
        item.asrConfidence ?? null,
        item.confidence,
        item.status,
        item.suspended ? 1 : 0,
        item.validFrom ?? null,
        item.validUntil ?? null,
        item.ttl ?? null,
        item.lastReinforced ?? null,
        JSON.stringify(item.provenance),
        JSON.stringify(item.acl),
        item.speakerEvidenceId ?? null,
        item.eventId ?? null,
        item.id,
      );
  }

  getMemoryItem(id: string): MemoryItem | undefined {
    const row = this.db.prepare(`SELECT * FROM memory_item WHERE id = ?`).get(id) as unknown as MemoryRow | undefined;
    return row ? rowToMemoryItem(row) : undefined;
  }

  deleteMemoryItem(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM memory_item WHERE id = ?`).run(id);
    return Number(result.changes ?? 0) > 0;
  }

  listOwnerMemories(ownerId: string, limit = 100): MemoryItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_item WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(ownerId, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemoryItem);
  }

  listMemoriesByOwner(ownerId: string, limit = 500): MemoryItem[] {
    return this.listOwnerMemories(ownerId, limit);
  }

  setMemorySuspended(id: string, suspended: boolean): boolean {
    const result = this.db.prepare(`UPDATE memory_item SET suspended = ? WHERE id = ?`).run(suspended ? 1 : 0, id);
    return Number(result.changes ?? 0) > 0;
  }

  listOwnerMemoriesByType(ownerId: string, type: MemoryType, limit = 100): MemoryItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_item WHERE owner_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?`)
      .all(ownerId, type, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemoryItem);
  }

  listMemoryByDimension(ownerId: string, dimension: string, limit = 20): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_item
         WHERE owner_id = ? AND json_extract(content_structured_json, '$.key') = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(ownerId, dimension, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemoryItem);
  }

  upsertPrefSummary(args: {
    ownerId: string;
    dimension: string;
    currentValue: string;
    activeConditions: Array<{ memoryId: string; value: string; ts: number }>;
    updatedAt?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pref_summary(owner_id, dimension, current_value, active_conditions_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, dimension) DO UPDATE SET
           current_value = excluded.current_value,
           active_conditions_json = excluded.active_conditions_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        args.ownerId,
        args.dimension,
        args.currentValue,
        JSON.stringify(args.activeConditions),
        args.updatedAt ?? Date.now(),
      );
  }

  deletePrefSummary(ownerId: string, dimension: string): void {
    this.db.prepare(`DELETE FROM pref_summary WHERE owner_id = ? AND dimension = ?`).run(ownerId, dimension);
  }

  listPrefSummaries(ownerId: string): Array<{
    ownerId: string;
    dimension: string;
    currentValue: string;
    activeConditions: Array<{ memoryId: string; value: string; ts: number }>;
    updatedAt: number;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM pref_summary WHERE owner_id = ? ORDER BY updated_at DESC`)
      .all(ownerId) as unknown as PrefSummaryRow[];
    return rows.map((row) => ({
      ownerId: row.owner_id,
      dimension: row.dimension,
      currentValue: row.current_value,
      activeConditions: JSON.parse(row.active_conditions_json) as Array<{ memoryId: string; value: string; ts: number }>,
      updatedAt: row.updated_at,
    }));
  }

  insertAudit(args: {
    id: string;
    ts?: number;
    ownerId?: string;
    kind: string;
    decision: Record<string, unknown>;
    rationale: string;
    signal: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO audit(id, ts, owner_id, kind, decision_json, rationale, signal_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.id,
        args.ts ?? Date.now(),
        args.ownerId ?? null,
        args.kind,
        JSON.stringify(args.decision),
        args.rationale,
        JSON.stringify(args.signal),
      );
  }

  countAudit(kind?: string): number {
    const row = kind
      ? (this.db.prepare(`SELECT COUNT(*) as n FROM audit WHERE kind = ?`).get(kind) as { n: number })
      : (this.db.prepare(`SELECT COUNT(*) as n FROM audit`).get() as { n: number });
    return Number(row.n);
  }

  listHotMemories(ownerId: string, limit = 8): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hot_readable_memories
         WHERE owner_id = ? OR namespace IN ('shared:household')
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(ownerId, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemoryItem);
  }

  /**
   * R1 相关性召回候选集：同 hot 视图可见性（committed/provisional、未挂起、未过期），
   * 排除 preference（该类由 pref_summary 层单独注入，不占相关位），cap 保护热路径。
   */
  listRecallCandidates(ownerId: string, cap = 2000): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hot_readable_memories
         WHERE (owner_id = ? OR namespace IN ('shared:household'))
           AND type != 'preference'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(ownerId, cap) as unknown as MemoryRow[];
    return rows.map(rowToMemoryItem);
  }

  listMemoriesByStatus(status: MemoryStatus): MemoryItem[] {
    const rows = this.db.prepare(`SELECT * FROM memory_item WHERE status = ? ORDER BY created_at`).all(status) as unknown as MemoryRow[];
    return rows.map(rowToMemoryItem);
  }

  count(table: 'event_log' | 'speaker_evidence' | 'memory_item'): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }
}

function rowToMemoryItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    ownerId: row.owner_id,
    namespace: row.namespace,
    type: row.type,
    content: JSON.parse(row.content_structured_json) as MemoryItem['content'],
    sourceRole: row.source_role,
    sourceSpan: row.source_span,
    asrConfidence: row.asr_confidence ?? undefined,
    confidence: row.confidence,
    status: row.status,
    suspended: Number(row.suspended ?? 0) === 1,
    validFrom: row.valid_from ?? undefined,
    validUntil: row.valid_until ?? undefined,
    ttl: row.ttl ?? undefined,
    createdAt: row.created_at,
    lastReinforced: row.last_reinforced ?? undefined,
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    acl: JSON.parse(row.acl_json) as Record<string, unknown>,
    speakerEvidenceId: row.speaker_evidence_id ?? undefined,
    eventId: row.event_id ?? undefined,
  };
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
