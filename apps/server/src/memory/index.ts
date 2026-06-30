import { createHash } from 'node:crypto';
import { SQLiteMemoryStorage } from './storage.js';
import { EventLog } from '../session/event-log.js';
import { VolcIdentityProvider, ownerIdFromVoiceprint } from './identity/index.js';
import type {
  IdentityProviderAdapter,
  Memory,
  MemoryItem,
  MemoryStatus,
  MemoryType,
  RecallQuery,
  RecallResult,
  RememberInput,
  RememberResult,
  StructuredMemoryContent,
} from './types.js';

export const storage = new SQLiteMemoryStorage();
export const identity: IdentityProviderAdapter = new VolcIdentityProvider(storage);
export const eventLog = new EventLog(storage);

export class MyJavisMemory implements Memory {
  constructor(
    private readonly db: SQLiteMemoryStorage,
    private readonly events: EventLog,
  ) {}

  async recall(q: RecallQuery): Promise<RecallResult> {
    const started = performance.now();
    if (!q.ownerId) {
      return {
        memories: [],
        working: q.working ?? [],
        readMemoryIds: [],
        injectedMemoryIds: [],
        usedProvisional: false,
        degradationReason: 'identity_unstable',
        elapsedMs: performance.now() - started,
      };
    }

    const memories = this.db.listHotMemories(q.ownerId, q.limit ?? 8);
    return {
      memories,
      working: q.working ?? [],
      readMemoryIds: memories.map((item) => item.id),
      injectedMemoryIds: memories.map((item) => item.id),
      usedProvisional: memories.some((item) => item.status === 'provisional'),
      elapsedMs: performance.now() - started,
    };
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const event =
      input.eventId && this.db.getEvent(input.eventId)
        ? this.db.getEvent(input.eventId)!
        : this.events.appendUtterance({
            roomId: input.roomId,
            speakerEvidenceId: input.identity?.evidence.id,
            isFinal: input.isFinal,
            sourceRole: input.sourceRole,
            utteranceText: input.utterance,
            heardByUser: input.sourceRole === 'assistant' ? true : undefined,
          });

    if (!input.isFinal) return { eventId: event.id, status: 'skipped', reason: 'not_final' };
    if (input.sourceRole !== 'user') return { eventId: event.id, status: 'skipped', reason: 'source_role_not_user' };

    const identityStable = input.identity?.state === 'active_stable' && Boolean(input.ownerId);
    const unsafe = isInstructionInjection(input.utterance);
    const status: MemoryStatus = identityStable && !unsafe ? 'provisional' : 'quarantine';
    const ownerId = identityStable && input.ownerId ? input.ownerId : 'unattributed';
    const type = inferMemoryType(input.utterance, unsafe);
    const content = structureMemory(input.utterance, type);
    const memoryId = deterministicMemoryId(input.roomId, input.utterance, input.identity?.evidence.id, type);

    const item: MemoryItem = {
      id: memoryId,
      ownerId,
      namespace: status === 'quarantine' ? `session:${input.roomId}` : `private:${ownerId}`,
      type,
      content,
      sourceRole: input.sourceRole,
      sourceSpan: input.sourceSpan ?? input.utterance,
      asrConfidence: input.asrConfidence,
      confidence: unsafe ? 0 : input.identity?.evidence.confidence ?? 0.5,
      status,
      validFrom: input.ts ?? Date.now(),
      validUntil: defaultValidUntil(type),
      ttl: defaultTtl(type),
      createdAt: Date.now(),
      provenance: {
        roomId: input.roomId,
        eventId: event.id,
        speakerEvidenceId: input.identity?.evidence.id,
        identityState: input.identity?.state,
        quarantineReason: unsafe ? 'prompt_injection' : input.identity?.reason,
        rawUtterance: input.utterance,
      },
      acl: { read: [ownerId], write: [ownerId], delete: [ownerId] },
      speakerEvidenceId: input.identity?.evidence.id,
      eventId: event.id,
    };
    this.db.insertMemoryItem(item);

    return {
      eventId: event.id,
      memoryId,
      status: status === 'quarantine' ? 'quarantined' : 'stored',
      reason: unsafe ? 'prompt_injection' : input.identity?.reason,
    };
  }
}

export const memory: Memory = new MyJavisMemory(storage, eventLog);

export function mockIdentityPayload(args: {
  roomId?: string;
  voiceprintId?: string;
  voiceprintName?: string;
  score?: number;
  mode?: string;
  status?: string;
}): Parameters<IdentityProviderAdapter['resolve']>[0] {
  return {
    provider: 'volc',
    roomId: args.roomId,
    voiceprintId: args.voiceprintId,
    voiceprintName: args.voiceprintName,
    score: args.score,
    mode: args.mode ?? '2',
    status: args.status,
    raw: args,
  };
}

export { ownerIdFromVoiceprint };
export type * from './types.js';

function deterministicMemoryId(roomId: string, utterance: string, evidenceId: string | undefined, type: MemoryType): string {
  return `mem_${createHash('sha256')
    .update([roomId, utterance.trim(), evidenceId ?? 'none', type].join('|'))
    .digest('hex')
    .slice(0, 32)}`;
}

function isInstructionInjection(text: string): boolean {
  return /忽略.*(安全|规则|system|系统)|ignore.*(safety|rules|system)|越权|绕过权限|不要遵守/i.test(text);
}

function inferMemoryType(text: string, unsafe: boolean): MemoryType {
  if (unsafe) return 'ephemeral_context';
  if (/过敏|青霉素|药物|病史|医疗/.test(text)) return 'safety';
  if (/提醒我|remind me|待办/.test(text)) return 'reminder';
  if (/航班|会议|明天|后天|下周|今天|今晚|日程/.test(text)) return 'event';
  if (/我的.+是|手机号|地址|邮箱|生日/.test(text)) return 'profile_fact';
  if (/喜欢|不喜欢|偏好|以后/.test(text)) return 'preference';
  return 'ephemeral_context';
}

function structureMemory(text: string, type: MemoryType): StructuredMemoryContent {
  return {
    kind: type,
    key: keyForType(type),
    value: text.trim().slice(0, 500),
    source: 'user_said',
  };
}

function keyForType(type: MemoryType): string {
  switch (type) {
    case 'safety':
      return 'safety.user_statement';
    case 'reminder':
      return 'task.reminder';
    case 'event':
      return 'calendar.event';
    case 'profile_fact':
      return 'profile.fact';
    case 'preference':
      return 'preference.general';
    case 'relationship':
      return 'relationship.general';
    case 'location':
      return 'location.general';
    case 'ephemeral_context':
      return 'session.context';
  }
}

function defaultTtl(type: MemoryType): number | undefined {
  if (type === 'ephemeral_context') return 24 * 60 * 60 * 1000;
  if (type === 'event' || type === 'reminder') return 30 * 24 * 60 * 60 * 1000;
  return undefined;
}

function defaultValidUntil(type: MemoryType): number | undefined {
  const ttl = defaultTtl(type);
  return ttl ? Date.now() + ttl : undefined;
}
