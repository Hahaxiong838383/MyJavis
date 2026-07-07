export type SourceRole = 'user' | 'assistant' | 'tool';
export type MemoryStatus = 'committed' | 'provisional' | 'quarantine';
export type MemoryType =
  | 'preference'
  | 'profile_fact'
  | 'event'
  | 'reminder'
  | 'relationship'
  | 'location'
  | 'safety'
  | 'ephemeral_context';
export type SpeakerEvidenceState =
  | 'unverified'
  | 'registering'
  | 'active_low'
  | 'active_stable'
  | 'revoked';

export interface VolcSpeakerPayload {
  provider?: string;
  roomId?: string;
  voiceprintId?: string;
  voiceprintName?: string;
  score?: number;
  mode?: string | number;
  status?: string;
  ts?: number;
  raw?: unknown;
}

export interface SpeakerEvidence {
  id: string;
  provider: string;
  voiceprintId?: string;
  voiceprintName?: string;
  score?: number;
  mode?: string;
  rawPayload: unknown;
  roomId: string;
  ts: number;
  state: SpeakerEvidenceState;
  confidence: number;
}

export interface IdentityResolution {
  evidence: SpeakerEvidence;
  ownerId?: string;
  state: SpeakerEvidenceState;
  quarantine: boolean;
  reason?: string;
}

export interface StructuredMemoryContent {
  kind: MemoryType;
  key: string;
  value: string;
  source: 'user_said' | 'tool' | 'explicit_confirmation';
}

export interface MemoryItem {
  id: string;
  ownerId: string;
  namespace: string;
  type: MemoryType;
  content: StructuredMemoryContent;
  sourceRole: SourceRole;
  sourceSpan: string;
  asrConfidence?: number;
  confidence: number;
  status: MemoryStatus;
  suspended?: boolean;
  validFrom?: number;
  validUntil?: number;
  ttl?: number;
  createdAt: number;
  lastReinforced?: number;
  provenance: Record<string, unknown>;
  acl: Record<string, unknown>;
  speakerEvidenceId?: string;
  eventId?: string;
}

export interface ChatWorkingTurn {
  role: SourceRole;
  content: string;
  ts: number;
}

export interface ContextBundle {
  memories: MemoryItem[];
  working: ChatWorkingTurn[];
  readMemoryIds: string[];
  injectedMemoryIds: string[];
  usedProvisional: boolean;
  degradationReason?: string;
  /** R1 相关性召回命中的 query 词（可解释性/telemetry）；走退化路径时缺省。 */
  matchedKeywords?: string[];
  /** 注入位里来自相关性召回的条数（其余为 recency 保底位）。 */
  relevantCount?: number;
}

export interface RecallQuery {
  ownerId?: string;
  query: string;
  working?: ChatWorkingTurn[];
  limit?: number;
  /** 房间 id（R2：用于合并 App 上行的通话级隐私上下文，见 privacy/session-context）。 */
  roomId?: string;
}

export interface RecallResult extends ContextBundle {
  elapsedMs: number;
}

export interface RememberInput {
  ownerId?: string;
  /** 租户上下文（R2 隐私路由 hold 队列按租户分桶；调用方从请求上下文透传）。 */
  tenantId?: string;
  identity?: IdentityResolution;
  eventId?: string;
  roomId: string;
  utterance: string;
  sourceRole: SourceRole;
  isFinal: boolean;
  asrConfidence?: number;
  sourceSpan?: string;
  ts?: number;
  recentMemoryIds?: string[];
  targetOwnerId?: string;
}

export interface RememberResult {
  eventId: string;
  memoryId?: string;
  status: 'stored' | 'updated' | 'deleted' | 'reattributed' | 'quarantined' | 'skipped' | 'privacy_routed';
  decision?: AdmissionDecision;
  reason?: string;
}

/** 治理面板召回预览（只读，与 recall 同一套检索逻辑 + 可解释明细）。 */
export interface RecallPreview {
  degraded: boolean;
  degradedReason?: 'empty_query_tokens' | 'no_match';
  matchedKeywords: string[];
  items: Array<{
    memory: MemoryItem;
    source: 'relevant' | 'recent' | 'fallback_hot';
    matched: string[];
    salience: number;
  }>;
}

export interface Memory {
  recall(q: RecallQuery): Promise<RecallResult>;
  recallPreview(ownerId: string, query: string): Promise<RecallPreview>;
  remember(input: RememberInput): Promise<RememberResult>;
  listByOwner(ownerId: string): Promise<MemoryItem[]>;
  suspend(ownerId: string, memoryId: string): Promise<GovernanceResult>;
  resume(ownerId: string, memoryId: string): Promise<GovernanceResult>;
  delete(ownerId: string, memoryId: string): Promise<GovernanceResult>;
  reassign(ownerId: string, memoryId: string, targetOwnerId: string): Promise<GovernanceResult>;
  exportOwner(ownerId: string): Promise<MemoryExport>;
}

export interface IdentityProviderAdapter {
  resolve(payload: VolcSpeakerPayload): IdentityResolution;
}

export interface MemoryCandidate {
  type: MemoryType;
  content: StructuredMemoryContent;
  salience: number;
  sourceSpan: string;
  dimension: string;
  ttl?: number;
  validUntil?: number;
  requiresConfirmation?: boolean;
}

export type AdmissionAction = 'ignore' | 'store' | 'update' | 'promote' | 'decay';

export interface AdmissionDecision {
  action: AdmissionAction;
  type: MemoryType;
  confidence: number;
  conflicts: string[];
  rationale: string;
  status?: MemoryStatus;
}

export type CorrectionAction = 'delete' | 'update' | 'reattribute' | 'lower_confidence';

export interface CorrectionIntent {
  action: CorrectionAction;
  span: string;
  replacement?: string;
  targetOwnerId?: string;
}

export interface GovernanceResult {
  ok: boolean;
  memoryId?: string;
  reason?: 'not_found' | 'cross_owner_rejected' | 'target_owner_required';
}

export interface MemoryExport {
  ownerId: string;
  exportedAt: number;
  memories: MemoryItem[];
}
