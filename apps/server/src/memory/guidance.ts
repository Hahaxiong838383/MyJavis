/**
 * 记忆引导闭环（方案A，docs/IMPL-R3.5-记忆体验修复-PROMPT.md §3）。
 *
 * 家庭模式（solo=false）下，声纹未识别导致这句话会被 memory.remember() quarantine 时，
 * 不能让用户无感知——但 remember 是 fire-and-forget（custom-llm.ts onDone 里 void 调用），
 * 拿不到本轮异步结果。故在调用前用同一套判定预判结果，标记房间级一次性提醒，
 * 下一轮组装 contextNote 时消费。TTL 防唠叨：提醒过一次后 5 分钟内不重复
 * （同 custom-llm.ts stickySpeakers 的 TTL Map 模式）。
 */
import type { SpeakerEvidenceState } from './types.js';

const GUIDANCE_TTL_MS = 5 * 60_000;
const guidancePending = new Set<string>();
const guidanceLastSentAt = new Map<string, number>();

export const GUIDANCE_CONTEXT_NOTE =
  '[系统提示] 刚才那句话因为还没认出说话人，暂存未记住。请自然地告诉用户：' +
  '说"我是XX，记住我的声音"完成声纹注册后，Javis 就能记住 TA 的事。';

/**
 * 与 memory/index.ts remember() 内部 quarantine 判定同构的预判：
 * solo=false 且身份未稳定且这句话确实抽得出记忆候选，才值得提醒
 * （solo=true 时 custom-llm.ts 传 soloStable=true，remember 永不会因身份走 quarantine 分支）。
 */
export function shouldGuideVoiceprintRegistration(
  soloMode: boolean | undefined,
  identityState: SpeakerEvidenceState,
  candidateCount: number,
): boolean {
  return soloMode === false && identityState !== 'active_stable' && candidateCount > 0;
}

export function markPendingGuidance(roomId: string, now = Date.now()): void {
  const last = guidanceLastSentAt.get(roomId) ?? 0;
  if (now - last < GUIDANCE_TTL_MS) return; // 冷却期内已提醒过，不重复标记（防唠叨）
  guidancePending.add(roomId);
}

/** 一次性消费：命中即清标记并进入下一轮冷却窗口。 */
export function consumePendingGuidance(roomId: string | undefined, now = Date.now()): boolean {
  if (!roomId || !guidancePending.has(roomId)) return false;
  guidancePending.delete(roomId);
  guidanceLastSentAt.set(roomId, now);
  return true;
}

/** 测试专用。 */
export function _resetGuidanceState(): void {
  guidancePending.clear();
  guidanceLastSentAt.clear();
}
