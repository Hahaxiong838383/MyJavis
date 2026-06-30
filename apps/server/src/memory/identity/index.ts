import { createHash } from 'node:crypto';
import type {
  IdentityProviderAdapter,
  IdentityResolution,
  SpeakerEvidence,
  SpeakerEvidenceState,
  VolcSpeakerPayload,
} from '../types.js';
import type { SQLiteMemoryStorage } from '../storage.js';

const LOW_CONFIDENCE = 0.4;
const STABLE_CONFIDENCE = 0.75;

export class VolcIdentityProvider implements IdentityProviderAdapter {
  constructor(private readonly storage: SQLiteMemoryStorage) {}

  resolve(payload: VolcSpeakerPayload): IdentityResolution {
    const evidence = normalizeSpeakerEvidence(payload);
    this.storage.insertSpeakerEvidence(evidence);

    if (evidence.state !== 'active_stable') {
      return {
        evidence,
        state: evidence.state,
        quarantine: true,
        reason: reasonForState(evidence.state),
      };
    }

    const ownerId = ownerIdFromVoiceprint(evidence.voiceprintId);
    this.storage.upsertOwner(ownerId, evidence.voiceprintName, evidence.state, evidence.id);
    return {
      evidence,
      ownerId,
      state: evidence.state,
      quarantine: false,
    };
  }
}

export function normalizeSpeakerEvidence(payload: VolcSpeakerPayload): SpeakerEvidence {
  const raw = payload.raw && typeof payload.raw === 'object' ? (payload.raw as Record<string, unknown>) : {};
  const voiceprintId = firstString(payload.voiceprintId, raw.voiceprintId, raw.voiceprint_id, raw.VoicePrintId);
  const voiceprintName = firstString(payload.voiceprintName, raw.voiceprintName, raw.voiceprint_name, raw.VoicePrintName);
  const score = normalizeScore(firstNumber(payload.score, raw.score, raw.Score));
  const mode = firstString(payload.mode, raw.mode, raw.Mode) ?? 'unknown';
  const roomId = payload.roomId ?? firstString(raw.roomId, raw.room_id, raw.RoomId) ?? 'unknown-room';
  const status = firstString(payload.status, raw.status, raw.Status);
  const ts = payload.ts ?? Date.now();
  const state = stateFromPayload({ voiceprintId, score, status });
  const confidence = confidenceFromState(state, score);
  const provider = payload.provider ?? 'volc';
  const id = stableId([
    provider,
    roomId,
    voiceprintId ?? 'none',
    String(score ?? 'none'),
    String(mode),
    status ?? 'none',
    String(ts),
  ]);

  return {
    id,
    provider,
    voiceprintId,
    voiceprintName,
    score,
    mode,
    rawPayload: payload.raw ?? payload,
    roomId,
    ts,
    state,
    confidence,
  };
}

export function ownerIdFromVoiceprint(voiceprintId: string | undefined): string {
  if (!voiceprintId) return 'unattributed';
  return `owner_${createHash('sha256').update(voiceprintId).digest('hex').slice(0, 16)}`;
}

function stateFromPayload(args: {
  voiceprintId?: string;
  score?: number;
  status?: string;
}): SpeakerEvidenceState {
  const status = args.status?.toLowerCase();
  if (status === 'revoked' || status === 'disabled') return 'revoked';
  if (!args.voiceprintId) return 'unverified';
  if (status === 'registering') return 'registering';
  if (args.score === undefined || args.score < LOW_CONFIDENCE) return 'registering';
  if (args.score < STABLE_CONFIDENCE) return 'active_low';
  return 'active_stable';
}

function confidenceFromState(state: SpeakerEvidenceState, score: number | undefined): number {
  if (state === 'revoked' || state === 'unverified') return 0;
  if (state === 'registering') return Math.max(0.2, score ?? 0.2);
  if (state === 'active_low') return score ?? 0.5;
  return score ?? 0.9;
}

function reasonForState(state: SpeakerEvidenceState): string {
  switch (state) {
    case 'unverified':
      return 'missing_voiceprint';
    case 'registering':
      return 'voiceprint_registering_or_score_too_low';
    case 'active_low':
      return 'voiceprint_low_confidence';
    case 'revoked':
      return 'voiceprint_revoked';
    case 'active_stable':
      return 'active_stable';
  }
}

function normalizeScore(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value > 1 ? value / 100 : value;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function stableId(parts: string[]): string {
  return `sev_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
}
