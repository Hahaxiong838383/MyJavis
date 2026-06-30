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
}

export interface RecallQuery {
  ownerId?: string;
  query: string;
  working?: ChatWorkingTurn[];
  limit?: number;
}

export interface RecallResult extends ContextBundle {
  elapsedMs: number;
}

export interface RememberInput {
  ownerId?: string;
  identity?: IdentityResolution;
  eventId?: string;
  roomId: string;
  utterance: string;
  sourceRole: SourceRole;
  isFinal: boolean;
  asrConfidence?: number;
  sourceSpan?: string;
  ts?: number;
}

export interface RememberResult {
  eventId: string;
  memoryId?: string;
  status: 'stored' | 'quarantined' | 'skipped';
  reason?: string;
}

export interface Memory {
  recall(q: RecallQuery): Promise<RecallResult>;
  remember(input: RememberInput): Promise<RememberResult>;
}

export interface IdentityProviderAdapter {
  resolve(payload: VolcSpeakerPayload): IdentityResolution;
}
