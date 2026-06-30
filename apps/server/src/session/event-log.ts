import { createHash } from 'node:crypto';
import type { EventLogRecord, SQLiteMemoryStorage } from '../memory/storage.js';
import type { SourceRole } from '../memory/types.js';

export interface AppendUtteranceInput {
  roomId: string;
  asrSegmentId?: string;
  speakerEvidenceId?: string;
  isFinal: boolean;
  sourceRole: SourceRole;
  utteranceText: string;
  utteranceStartTs?: number;
  utteranceEndTs?: number;
  llmResponseId?: string;
  ttsPlaybackStartTs?: number;
  ttsPlaybackEndTs?: number;
  interruptedAt?: number;
  heardByUser?: boolean;
}

export class EventLog {
  constructor(private readonly storage: SQLiteMemoryStorage) {}

  appendUtterance(input: AppendUtteranceInput): EventLogRecord {
    const now = Date.now();
    const asrSegmentId =
      input.asrSegmentId ?? hashCandidate(input.roomId, input.utteranceText, input.speakerEvidenceId, 'full', 'asr_segment');
    const record: EventLogRecord = {
      id: hashCandidate(input.roomId, input.utteranceText, input.speakerEvidenceId, asrSegmentId, input.sourceRole),
      roomId: input.roomId,
      asrSegmentId,
      speakerEvidenceId: input.speakerEvidenceId,
      isFinal: input.isFinal,
      sourceRole: input.sourceRole,
      utteranceText: input.utteranceText,
      utteranceStartTs: input.utteranceStartTs ?? now,
      utteranceEndTs: input.utteranceEndTs ?? now,
      llmResponseId: input.llmResponseId,
      ttsPlaybackStartTs: input.ttsPlaybackStartTs,
      ttsPlaybackEndTs: input.ttsPlaybackEndTs,
      interruptedAt: input.interruptedAt,
      heardByUser: input.heardByUser,
      createdAt: now,
    };
    this.storage.insertEvent(record);
    return record;
  }
}

export function hashCandidate(
  roomId: string,
  utterance: string,
  evidenceId: string | undefined,
  sourceSpan: string,
  candidateType: string,
): string {
  return `evt_${createHash('sha256')
    .update([roomId, utterance.trim(), evidenceId ?? 'none', sourceSpan, candidateType].join('|'))
    .digest('hex')
    .slice(0, 32)}`;
}
