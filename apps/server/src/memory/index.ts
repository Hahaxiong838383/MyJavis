import { createHash } from 'node:crypto';
import { SQLiteMemoryStorage } from './storage.js';
import { EventLog } from '../session/event-log.js';
import { mixRecall, tokenizeQuery, warmupTokenizer, type RecallDoc } from '../memory-core/index.js';
import { classifyPrivacy, hasSensitiveContent } from '../memory-core/privacy.js';
import { holdPrivacyItem } from '../privacy/hold-store.js';
import { getSessionContextForOwner, type SessionPrivacyItem } from '../privacy/session-context.js';
import { pushActivity } from '../activity/feed.js';
import { VolcIdentityProvider, ownerIdFromVoiceprint } from './identity/index.js';
import { admitCandidate, auditId } from './admission.js';
import { extractCorrectionIntent, extractMemoryCandidates, isInstructionInjection, maybeEscalateAmbiguousToLlm } from './candidates.js';
import { noteMemoryWritten } from './consolidation.js';
import type {
  GovernanceResult,
  IdentityProviderAdapter,
  Memory,
  MemoryExport,
  MemoryItem,
  MemoryStatus,
  MemoryType,
  MemoryCandidate,
  RecallPreview,
  RecallQuery,
  RecallResult,
  RememberInput,
  RememberResult,
  StructuredMemoryContent,
} from './types.js';

export const storage = new SQLiteMemoryStorage();
export const identity: IdentityProviderAdapter = new VolcIdentityProvider(storage);
export const eventLog = new EventLog(storage);

// jieba 词典预热（~5ms，一次性），避免摊在首轮通话的 recall 上
warmupTokenizer();

/** 相关性召回候选上限：几千条内打分毫秒级（单测哨兵 2000 条 <150ms），超出取最近。 */
const RECALL_CANDIDATE_CAP = 2000;

/** MemoryItem → 检索文档：索引文本 = 结构化 key/value + ASR 原话片段（原话是召回的富矿）。 */
function toRecallDoc(item: MemoryItem): RecallDoc {
  return {
    id: item.id,
    text: [item.content.key, item.content.value, item.sourceSpan].filter(Boolean).join(' '),
    createdAt: item.createdAt,
    confidenceWeight: item.status === 'provisional' ? 0.7 : 1.0,
  };
}

/** 通话级隐私上下文项 → 轻量 MemoryItem（仅供本轮 prompt 注入，绝不落库）。 */
function sessionItemToMemoryItem(item: SessionPrivacyItem): MemoryItem {
  const knownTypes: MemoryType[] = ['preference', 'profile_fact', 'event', 'reminder', 'relationship', 'location', 'safety', 'ephemeral_context'];
  const type = (knownTypes as string[]).includes(item.type) ? (item.type as MemoryType) : 'profile_fact';
  return {
    id: item.id,
    ownerId: item.ownerId,
    namespace: `private:${item.ownerId}`,
    type,
    content: { kind: type, key: 'vault.local', value: item.text, source: 'user_said' },
    sourceRole: 'user',
    sourceSpan: '',
    confidence: 1,
    status: 'committed',
    createdAt: item.createdAt,
    provenance: { origin: 'local_vault' },
    acl: { read: [item.ownerId], write: [item.ownerId], delete: [item.ownerId] },
  };
}

export class MyJavisMemory implements Memory {
  constructor(
    private readonly db: SQLiteMemoryStorage,
    private readonly events: EventLog,
  ) {}

  async listByOwner(ownerId: string): Promise<MemoryItem[]> {
    return this.db.listMemoriesByOwner(ownerId);
  }

  async exportOwner(ownerId: string): Promise<MemoryExport> {
    return {
      ownerId,
      exportedAt: Date.now(),
      memories: this.db.listMemoriesByOwner(ownerId),
    };
  }

  async suspend(ownerId: string, memoryId: string): Promise<GovernanceResult> {
    const item = this.db.getMemoryItem(memoryId);
    if (!item) return { ok: false, reason: 'not_found', memoryId };
    if (item.ownerId !== ownerId) return this.rejectCrossOwner('suspend', ownerId, item);
    this.db.setMemorySuspended(memoryId, true);
    if (item.type === 'preference') this.recomputePrefSummary(ownerId, item.content.key);
    this.auditGovernance('suspend', ownerId, memoryId);
    return { ok: true, memoryId };
  }

  async resume(ownerId: string, memoryId: string): Promise<GovernanceResult> {
    const item = this.db.getMemoryItem(memoryId);
    if (!item) return { ok: false, reason: 'not_found', memoryId };
    if (item.ownerId !== ownerId) return this.rejectCrossOwner('resume', ownerId, item);
    this.db.setMemorySuspended(memoryId, false);
    if (item.type === 'preference') this.recomputePrefSummary(ownerId, item.content.key);
    this.auditGovernance('resume', ownerId, memoryId);
    return { ok: true, memoryId };
  }

  async delete(ownerId: string, memoryId: string): Promise<GovernanceResult> {
    const item = this.db.getMemoryItem(memoryId);
    if (!item) return { ok: false, reason: 'not_found', memoryId };
    if (item.ownerId !== ownerId) return this.rejectCrossOwner('delete', ownerId, item);
    this.db.deleteMemoryItem(memoryId);
    if (item.type === 'preference') this.recomputePrefSummary(ownerId, item.content.key);
    this.auditGovernance('delete', ownerId, memoryId);
    return { ok: true, memoryId };
  }

  async reassign(ownerId: string, memoryId: string, targetOwnerId: string): Promise<GovernanceResult> {
    if (!targetOwnerId) return { ok: false, reason: 'target_owner_required', memoryId };
    const item = this.db.getMemoryItem(memoryId);
    if (!item) return { ok: false, reason: 'not_found', memoryId };
    if (item.ownerId !== ownerId) return this.rejectCrossOwner('reassign', ownerId, item);
    const next: MemoryItem = {
      ...item,
      ownerId: targetOwnerId,
      namespace: `private:${targetOwnerId}`,
      acl: { read: [targetOwnerId], write: [targetOwnerId], delete: [targetOwnerId] },
    };
    this.db.updateMemoryItem(next);
    if (item.type === 'preference') {
      this.recomputePrefSummary(ownerId, item.content.key);
      this.recomputePrefSummary(targetOwnerId, item.content.key);
    }
    this.auditGovernance('reassign', ownerId, memoryId, { targetOwnerId });
    return { ok: true, memoryId };
  }

  /**
   * 召回预览（治理面板"试试 Javis 会想起什么"）：与 recall() 同一套检索逻辑，
   * 但返回带解释的完整明细（命中词/得分/相关位 vs 保底位/退化原因），只读不注入。
   */
  async recallPreview(ownerId: string, query: string): Promise<RecallPreview> {
    const candidates = this.db.listRecallCandidates(ownerId, RECALL_CANDIDATE_CAP);
    const byId = new Map(candidates.map((item) => [item.id, item]));
    const mix = mixRecall(query, candidates.map(toRecallDoc), { relevantK: 5, recentK: 3, cap: 8 });
    if (mix.picked) {
      const items = mix.details
        .map((detail) => {
          const memory = byId.get(detail.id);
          return memory ? { memory, source: detail.source, matched: detail.matched, salience: detail.salience } : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      return { degraded: false, matchedKeywords: mix.matchedKeywords, items };
    }
    // 退化：展示旧路径（最近高置信）会注入什么，并说明原因
    const hot = this.db.listHotMemories(ownerId, 8).filter((item) => item.type !== 'preference');
    return {
      degraded: true,
      degradedReason: tokenizeQuery(query).length === 0 ? 'empty_query_tokens' : 'no_match',
      matchedKeywords: [],
      items: hot.map((memory) => ({ memory, source: 'fallback_hot' as const, matched: [], salience: 0 })),
    };
  }

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

    const limit = q.limit ?? 8;
    const preferenceSummaries = this.db.listPrefSummaries(q.ownerId).map((summary) => prefSummaryToMemoryItem(summary));

    // R1 相关性召回（docs/memory-architecture.md §5.2）：jieba 分词 + IDF-local 打分 +
    // salience(×recency×confidence) 相关位 top-5 + recency 保底 3。
    // 退化契约：query 无有效词 / 零命中 → picked=null → 完全走升级前"最近高置信"路径，
    // 最坏情况严格等于旧行为。
    let hot: MemoryItem[] | null = null;
    let matchedKeywords: string[] | undefined;
    let relevantCount: number | undefined;
    if (q.query?.trim()) {
      const candidates = this.db.listRecallCandidates(q.ownerId, RECALL_CANDIDATE_CAP);
      // R2：合并通话级隐私上下文（App 上行的本机 vault 记忆，已按 owner 过滤——分人红线）；
      // 与云端候选同池统一打分，server 全程内存零落盘。
      const sessionItems = getSessionContextForOwner(q.roomId, q.ownerId);
      if (candidates.length > 0 || sessionItems.length > 0) {
        const byId = new Map<string, MemoryItem>(candidates.map((item) => [item.id, item]));
        for (const s of sessionItems) if (!byId.has(s.id)) byId.set(s.id, sessionItemToMemoryItem(s));
        const docs = [
          ...candidates.map(toRecallDoc),
          ...sessionItems.map((s) => ({ id: s.id, text: s.text, createdAt: s.createdAt, confidenceWeight: 1.0 })),
        ];
        const mix = mixRecall(q.query, docs, { relevantK: 5, recentK: 3, cap: limit });
        if (mix.picked) {
          hot = mix.picked.map((doc) => byId.get(doc.id)).filter((item): item is MemoryItem => Boolean(item));
          matchedKeywords = mix.matchedKeywords;
          relevantCount = mix.relevantCount;
        }
      }
    }
    if (!hot) {
      hot = this.db.listHotMemories(q.ownerId, limit).filter((item) => item.type !== 'preference');
    }

    const memories = [...preferenceSummaries, ...hot].slice(0, limit);
    if (matchedKeywords?.length) {
      pushActivity(q.tenantId, {
        kind: 'recall',
        summary: `想起 ${relevantCount ?? 0} 条相关记忆（命中：${matchedKeywords.slice(0, 4).join('、')}）`,
        detail: { matchedKeywords, relevantCount, injected: memories.length },
      });
    }
    return {
      memories,
      working: q.working ?? [],
      readMemoryIds: memories.map((item) => item.id),
      injectedMemoryIds: memories.map((item) => item.id),
      usedProvisional: memories.some((item) => item.status === 'provisional'),
      matchedKeywords,
      relevantCount,
      elapsedMs: performance.now() - started,
    };
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const event =
      input.eventId && this.db.getEvent(input.eventId)
        ? this.db.getEvent(input.eventId)!
        : this.events.appendUtterance({
            roomId: input.roomId,
            tenantId: input.tenantId,
            speakerEvidenceId: input.identity?.evidence.id,
            isFinal: input.isFinal,
            sourceRole: input.sourceRole,
            utteranceText: input.utterance,
            heardByUser: input.sourceRole === 'assistant' ? true : undefined,
          });

    if (!input.isFinal) return { eventId: event.id, status: 'skipped', reason: 'not_final' };
    if (input.sourceRole !== 'user') return { eventId: event.id, status: 'skipped', reason: 'source_role_not_user' };

    // R3.5 单人模式：soloStable=true 时绕过声纹稳定性门槛（声纹证据链本身不动，identity 层保持纯净）。
    const identityStable = input.soloStable === true || (input.identity?.state === 'active_stable' && Boolean(input.ownerId));
    const unsafe = isInstructionInjection(input.utterance);
    const ownerId = identityStable && input.ownerId ? input.ownerId : 'unattributed';

    const correction = extractCorrectionIntent(input.utterance);
    if (correction) {
      return this.applyCorrection({ input, ownerId, eventId: event.id, correction });
    }

    if (unsafe) {
      const item = this.buildMemoryItem({
        input,
        ownerId: 'unattributed',
        eventId: event.id,
        candidate: fallbackCandidate(input.utterance, 'ephemeral_context'),
        status: 'quarantine',
        confidence: 0,
        reason: 'prompt_injection',
      });
      const routed = this.routePrivacy(item, input, event.id, true);
      if (routed) return routed;
      this.db.insertMemoryItem(item);
      this.audit({
        ownerId,
        kind: 'admission',
        decision: { action: 'ignore', type: item.type, confidence: 0, conflicts: [], rationale: 'prompt_injection' },
        rationale: 'prompt_injection',
        signal: { utterance: input.utterance, eventId: event.id },
      });
      return { eventId: event.id, memoryId: item.id, status: 'quarantined', reason: 'prompt_injection' };
    }

    const candidates = extractMemoryCandidates(input.utterance, input.ts ?? Date.now());
    // R2 整轮敏感预判：本轮任何 audit/event 是否需要脱敏——一句话可能同时抽出隐私+普通
    // 候选，普通候选的审计若带全句原话同样泄露；无候选句子命中敏感词也顺手脱敏。
    const turnSensitive =
      hasSensitiveContent(input.utterance) ||
      candidates.some((cand) => classifyPrivacy({ type: cand.type, key: cand.content.key, value: cand.content.value, sourceSpan: cand.sourceSpan }).isPrivate);
    const auditUtterance = turnSensitive ? '[隐私脱敏]' : input.utterance;
    if (candidates.length === 0) {
      if (turnSensitive) this.db.redactEventUtterance(event.id, '[隐私脱敏:无记忆候选]');
      const escalation = maybeEscalateAmbiguousToLlm();
      this.audit({
        ownerId,
        kind: 'admission',
        decision: { action: 'ignore', type: 'ephemeral_context', confidence: 0, conflicts: [], rationale: 'no_explicit_trigger' },
        rationale: 'no_explicit_trigger',
        signal: { utterance: auditUtterance, eventId: event.id, escalation },
      });
      return { eventId: event.id, status: 'skipped', reason: 'no_explicit_trigger' };
    }

    if (!identityStable) {
      const item = this.buildMemoryItem({
        input,
        ownerId: 'unattributed',
        eventId: event.id,
        candidate: candidates[0]!,
        status: 'quarantine',
        confidence: input.identity?.evidence.confidence ?? 0,
        reason: input.identity?.reason ?? 'identity_unstable',
      });
      // R3.5 引导闭环：家庭模式下声纹未识别导致暂存，活动面板可见（零内容，只说明发生了什么）。
      pushActivity(input.tenantId, {
        kind: 'quarantine',
        summary: '有一句话暂存了（还没认出说话人，注册声纹后我才能记住）',
      });
      const routed = this.routePrivacy(item, input, event.id, true);
      if (routed) return routed;
      this.db.insertMemoryItem(item);
      this.audit({
        ownerId,
        kind: 'admission',
        decision: {
          action: 'ignore',
          type: item.type,
          confidence: item.confidence,
          conflicts: [],
          rationale: input.identity?.reason ?? 'identity_unstable',
          status: 'quarantine',
        },
        rationale: input.identity?.reason ?? 'identity_unstable',
        signal: {
          utterance: auditUtterance,
          eventId: event.id,
          candidate: turnSensitive ? { type: candidates[0]!.type, key: candidates[0]!.content.key } : candidates[0],
        },
      });
      return { eventId: event.id, memoryId: item.id, status: 'quarantined', reason: input.identity?.reason ?? 'identity_unstable' };
    }

    let lastResult: RememberResult = { eventId: event.id, status: 'skipped', reason: 'no_candidate' };
    for (const candidate of candidates) {
      const existing = this.db.listMemoryByDimension(ownerId, candidate.dimension, 20);
      const decision = admitCandidate({ candidate, existing, now: input.ts ?? Date.now() });
      this.audit({
        ownerId,
        kind: 'admission',
        decision: decision as unknown as Record<string, unknown>,
        rationale: decision.rationale,
        signal: {
          utterance: auditUtterance,
          eventId: event.id,
          candidate: turnSensitive ? { type: candidate.type, key: candidate.content.key } : candidate,
        },
      });
      if (decision.action === 'ignore') {
        lastResult = { eventId: event.id, status: 'skipped', decision, reason: decision.rationale };
        continue;
      }
      if (decision.action === 'promote') {
        const reinforced = this.reinforceExisting(existing, candidate, decision.status ?? 'committed');
        if (reinforced) {
          lastResult = { eventId: event.id, memoryId: reinforced.id, status: 'updated', decision };
          continue;
        }
      }
      const item = this.buildMemoryItem({
        input,
        ownerId,
        eventId: event.id,
        candidate,
        status: decision.status ?? 'provisional',
        confidence: decision.confidence,
        conflicts: decision.conflicts,
      });
      const routed = this.routePrivacy(item, input, event.id, false);
      if (routed) {
        lastResult = routed;
        continue;
      }
      this.db.insertMemoryItem(item);
      // R4 profile 重算触发（doc §5.2/§6 R4）：每 owner 每新增一条记忆计数一次，O(1) 内存自增，
      // 不做任何 I/O——满 50 条才真正重算 pref_summary（见 consolidation.ts 头注）。
      noteMemoryWritten(ownerId, this.db, input.tenantId);
      // R3 bi-temporal：update 决策 = 新事实取代旧事实——旧冲突行置 invalid（不删除，历史可溯）
      if (decision.action === 'update' && decision.conflicts.length > 0) {
        const invalidated = this.db.invalidateMemoryItems(decision.conflicts);
        if (invalidated > 0) {
          pushActivity(input.tenantId, {
            kind: 'invalidate',
            summary: `旧事实已更新：${invalidated} 条被新说法取代（保留历史）`,
            detail: { type: candidate.type, count: invalidated },
          });
        }
      }
      if (candidate.type === 'preference') this.recomputePrefSummary(ownerId, candidate.dimension);
      pushActivity(input.tenantId, {
        kind: 'write',
        summary: `记住了（${candidate.type}）：${candidate.content.value.slice(0, 24)}`,
        detail: { type: candidate.type, key: candidate.content.key, action: decision.action },
      });
      lastResult = {
        eventId: event.id,
        memoryId: item.id,
        status: decision.action === 'update' ? 'updated' : 'stored',
        decision,
      };
    }

    return lastResult;
  }

  /**
   * R2 隐私路由（docs/memory-architecture.md §4.2）：命中 → 云端零持久化。
   * - 正常记忆：进内存 hold 队列等 App 拉走落本机 vault；无租户上下文=无拉取方 → 直接丢弃（宁丢勿泄）。
   * - quarantine 记忆（注入嫌疑/身份不稳）：可疑内容不给 App，直接丢弃。
   * - 两种情况都回头脱敏 event_log 原话行；审计只记 type/命中依据，绝不记内容。
   * 未命中返回 null，调用方走原路径。
   */
  private routePrivacy(item: MemoryItem, input: RememberInput, eventId: string, isQuarantine: boolean): RememberResult | null {
    const privacy = classifyPrivacy({
      type: item.type,
      key: item.content.key,
      value: item.content.value,
      sourceSpan: item.sourceSpan,
    });
    if (!privacy.isPrivate) return null;

    let rationale: string;
    if (isQuarantine) {
      rationale = 'privacy_quarantine_dropped';
    } else if (input.tenantId) {
      const { dropped } = holdPrivacyItem(input.tenantId, item, privacy);
      rationale = dropped > 0 ? `privacy_routed_evicted_${dropped}` : 'privacy_routed';
    } else {
      rationale = 'privacy_dropped_no_tenant';
    }
    this.db.redactEventUtterance(eventId, `[隐私路由:${item.type}]`);
    if (!isQuarantine && input.tenantId) {
      pushActivity(input.tenantId, {
        kind: 'privacy_route',
        summary: '1 条敏感记忆已转移到你的电脑（云端不保留）',
        detail: { type: item.type },
      });
    }
    this.audit({
      ownerId: item.ownerId,
      kind: 'privacy',
      decision: { action: 'route', type: item.type, reason: privacy.reason, hit: privacy.hit, rationale },
      rationale,
      signal: { eventId, memoryId: item.id },
    });
    return { eventId, memoryId: item.id, status: 'privacy_routed', reason: rationale };
  }

  private buildMemoryItem(args: {
    input: RememberInput;
    ownerId: string;
    eventId: string;
    candidate: MemoryCandidate;
    status: MemoryStatus;
    confidence: number;
    conflicts?: string[];
    reason?: string;
  }): MemoryItem {
    const createdAt = monotonicNow();
    return {
      id: deterministicMemoryId(
        args.input.roomId,
        args.candidate.sourceSpan,
        args.input.identity?.evidence.id,
        args.candidate.type,
        args.candidate.dimension,
      ),
      ownerId: args.ownerId,
      namespace: args.status === 'quarantine' ? `session:${args.input.roomId}` : `private:${args.ownerId}`,
      type: args.candidate.type,
      content: args.candidate.content,
      sourceRole: args.input.sourceRole,
      sourceSpan: args.input.sourceSpan ?? args.candidate.sourceSpan,
      asrConfidence: args.input.asrConfidence,
      confidence: args.confidence,
      status: args.status,
      validFrom: args.input.ts ?? createdAt,
      validUntil: args.candidate.validUntil ?? defaultValidUntil(args.candidate.type),
      ttl: args.candidate.ttl ?? defaultTtl(args.candidate.type),
      createdAt,
      provenance: {
        roomId: args.input.roomId,
        eventId: args.eventId,
        speakerEvidenceId: args.input.identity?.evidence.id,
        identityState: args.input.identity?.state,
        quarantineReason: args.reason,
        rawUtterance: args.input.utterance,
        conflicts: args.conflicts ?? [],
        salience: args.candidate.salience,
      },
      acl: { read: [args.ownerId], write: [args.ownerId], delete: [args.ownerId] },
      speakerEvidenceId: args.input.identity?.evidence.id,
      eventId: args.eventId,
    };
  }

  private reinforceExisting(existing: MemoryItem[], candidate: MemoryCandidate, status: MemoryStatus): MemoryItem | undefined {
    const target = existing.find((item) => item.content.value === candidate.content.value);
    if (!target) return undefined;
    const next: MemoryItem = {
      ...target,
      confidence: Math.min(0.99, target.confidence + 0.08),
      status,
      lastReinforced: Date.now(),
    };
    this.db.updateMemoryItem(next);
    if (next.type === 'preference') this.recomputePrefSummary(next.ownerId, next.content.key);
    return next;
  }

  private applyCorrection(args: {
    input: RememberInput;
    ownerId: string;
    eventId: string;
    correction: NonNullable<ReturnType<typeof extractCorrectionIntent>>;
  }): RememberResult {
    if (!args.input.ownerId || args.ownerId === 'unattributed') {
      return { eventId: args.eventId, status: 'skipped', reason: 'identity_unstable_for_correction' };
    }
    const target = this.resolveCorrectionTarget(args.ownerId, args.input.recentMemoryIds);
    if (!target) return { eventId: args.eventId, status: 'skipped', reason: 'correction_target_required' };
    if (target.ownerId !== args.ownerId) {
      this.audit({
        ownerId: args.ownerId,
        kind: 'correction',
        decision: { action: args.correction.action, rejected: true, targetMemoryId: target.id },
        rationale: 'cross_owner_correction_rejected',
        signal: { utterance: args.input.utterance },
      });
      return { eventId: args.eventId, memoryId: target.id, status: 'skipped', reason: 'cross_owner_rejected' };
    }

    if (args.correction.action === 'delete') {
      this.db.deleteMemoryItem(target.id);
      if (target.type === 'preference') this.recomputePrefSummary(target.ownerId, target.content.key);
      this.auditCorrection(args, target.id, 'delete');
      return { eventId: args.eventId, memoryId: target.id, status: 'deleted' };
    }

    if (args.correction.action === 'reattribute') {
      if (!args.input.targetOwnerId) {
        return { eventId: args.eventId, memoryId: target.id, status: 'skipped', reason: 'target_owner_required' };
      }
      const next = {
        ...target,
        ownerId: args.input.targetOwnerId,
        namespace: `private:${args.input.targetOwnerId}`,
        acl: { read: [args.input.targetOwnerId], write: [args.input.targetOwnerId], delete: [args.input.targetOwnerId] },
      };
      this.db.updateMemoryItem(next);
      if (target.type === 'preference') {
        this.recomputePrefSummary(target.ownerId, target.content.key);
        this.recomputePrefSummary(next.ownerId, next.content.key);
      }
      this.auditCorrection(args, target.id, 'reattribute');
      return { eventId: args.eventId, memoryId: target.id, status: 'reattributed' };
    }

    if (args.correction.action === 'update' && args.correction.replacement) {
      const next = {
        ...target,
        content: { ...target.content, value: args.correction.replacement },
        confidence: Math.min(0.99, target.confidence + 0.05),
        lastReinforced: Date.now(),
      };
      this.db.updateMemoryItem(next);
      if (next.type === 'preference') this.recomputePrefSummary(next.ownerId, next.content.key);
      this.auditCorrection(args, target.id, 'update');
      return { eventId: args.eventId, memoryId: target.id, status: 'updated' };
    }

    const next = { ...target, confidence: Math.max(0, target.confidence - 0.3) };
    this.db.updateMemoryItem(next);
    this.auditCorrection(args, target.id, 'lower_confidence');
    return { eventId: args.eventId, memoryId: target.id, status: 'updated' };
  }

  private resolveCorrectionTarget(ownerId: string, recentMemoryIds: string[] | undefined): MemoryItem | undefined {
    for (const id of recentMemoryIds ?? []) {
      const item = this.db.getMemoryItem(id);
      if (item) return item;
    }
    return this.db.listOwnerMemories(ownerId, 1)[0];
  }

  private auditCorrection(
    args: { input: RememberInput; ownerId: string; eventId: string; correction: NonNullable<ReturnType<typeof extractCorrectionIntent>> },
    targetMemoryId: string,
    action: string,
  ): void {
    this.audit({
      ownerId: args.ownerId,
      kind: 'correction',
      decision: { action, targetMemoryId, replacement: args.correction.replacement, targetOwnerId: args.input.targetOwnerId },
      rationale: `correction_${action}`,
      signal: { utterance: args.input.utterance, eventId: args.eventId },
    });
  }

  private recomputePrefSummary(ownerId: string, dimension: string): void {
    const active = this.db
      .listMemoryByDimension(ownerId, dimension, 20)
      .filter((item) => item.type === 'preference' && item.status !== 'quarantine' && !item.suspended)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((item) => ({ memoryId: item.id, value: item.content.value, ts: item.createdAt }));
    if (active.length === 0) {
      this.db.deletePrefSummary(ownerId, dimension);
      return;
    }
    this.db.upsertPrefSummary({
      ownerId,
      dimension,
      currentValue: active[0]!.value,
      activeConditions: active,
    });
  }

  private audit(args: {
    ownerId?: string;
    kind: string;
    decision: Record<string, unknown>;
    rationale: string;
    signal: Record<string, unknown>;
  }): void {
    this.db.insertAudit({
      id: auditId([args.kind, args.ownerId ?? 'none', args.rationale, JSON.stringify(args.signal)]),
      ownerId: args.ownerId,
      kind: args.kind,
      decision: args.decision,
      rationale: args.rationale,
      signal: args.signal,
    });
  }

  private rejectCrossOwner(action: string, ownerId: string, item: MemoryItem): GovernanceResult {
    this.auditGovernance(action, ownerId, item.id, { rejected: true, actualOwnerId: item.ownerId });
    return { ok: false, reason: 'cross_owner_rejected', memoryId: item.id };
  }

  private auditGovernance(action: string, ownerId: string, memoryId: string, extra: Record<string, unknown> = {}): void {
    this.audit({
      ownerId,
      kind: 'governance',
      decision: { action, memoryId, ...extra },
      rationale: `governance_${action}`,
      signal: { memoryId, ...extra },
    });
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

function deterministicMemoryId(
  roomId: string,
  utterance: string,
  evidenceId: string | undefined,
  type: MemoryType,
  dimension: string,
): string {
  return `mem_${createHash('sha256')
    .update([roomId, utterance.trim(), evidenceId ?? 'none', type, dimension].join('|'))
    .digest('hex')
    .slice(0, 32)}`;
}

function fallbackCandidate(text: string, type: MemoryType): MemoryCandidate {
  return {
    type,
    content: structureMemory(text, type),
    salience: 0,
    sourceSpan: text,
    dimension: keyForType(type),
  };
}

function structureMemory(text: string, type: MemoryType): StructuredMemoryContent {
  return { kind: type, key: keyForType(type), value: text.trim().slice(0, 500), source: 'user_said' };
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

function prefSummaryToMemoryItem(summary: {
  ownerId: string;
  dimension: string;
  currentValue: string;
  activeConditions: Array<{ memoryId: string; value: string; ts: number }>;
  updatedAt: number;
}): MemoryItem {
  return {
    id: `pref_${createHash('sha256').update(`${summary.ownerId}:${summary.dimension}`).digest('hex').slice(0, 20)}`,
    ownerId: summary.ownerId,
    namespace: `private:${summary.ownerId}`,
    type: 'preference',
    content: {
      kind: 'preference',
      key: summary.dimension,
      value: summary.currentValue,
      source: 'user_said',
    },
    sourceRole: 'user',
    sourceSpan: summary.currentValue,
    confidence: 0.8,
    status: 'committed',
    createdAt: summary.updatedAt,
    lastReinforced: summary.updatedAt,
    provenance: { prefSummary: true, activeConditions: summary.activeConditions },
    acl: { read: [summary.ownerId], write: [summary.ownerId], delete: [summary.ownerId] },
  };
}

let lastNow = 0;
function monotonicNow(): number {
  const now = Date.now();
  lastNow = now <= lastNow ? lastNow + 1 : now;
  return lastNow;
}
