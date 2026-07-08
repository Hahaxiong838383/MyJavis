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

// ---------- solo 0 声纹引导（2026-07-08 川哥拍板）----------
// 单人模式下记忆不依赖声纹，但声纹服务于称呼个性化与后续降噪等扩展能力，
// 0 声纹的租户也要引导注册。与家庭模式引导（补救性质，房间级 5min）不同：
// 这是推广性质，租户级 24h 冷却，直到注册第一条声纹后条件自然消失。
// 判定与落账分离：组装 contextNote 时判定，流正常完成（onDone 未被火山弃播）
// 才 markSoloGuidanceSent——interim/barge-in 弃用轮不消耗 24h 配额（引导没真说出口）。

const SOLO_GUIDANCE_TTL_MS = 24 * 3600_000;
const soloGuidanceLastSentAt = new Map<string, number>(); // tenantId → 上次真实播出时刻

export const SOLO_GUIDANCE_CONTEXT_NOTE =
  '[系统提示] 用户还没有注册声纹。请先正常回答用户这句话，然后在结尾自然地顺带提一句：' +
  '说「我是XX，记住我的声音」就能注册声纹，之后 Javis 一听声音就认得 TA、会用名字称呼。' +
  '轻松一句话带过，不推销；不要提"系统/设置/单人模式"这类机制词。';

export function shouldGuideSoloVoiceprintOnboarding(
  soloMode: boolean | undefined,
  voiceprintCount: number,
  tenantId: string | undefined,
  now = Date.now(),
): boolean {
  if (soloMode !== true || voiceprintCount > 0 || !tenantId) return false;
  const last = soloGuidanceLastSentAt.get(tenantId);
  if (last === undefined) return true; // 从未引导过：无条件触发（不能用 now-0 比 TTL，小时钟下会误判）
  return now - last >= SOLO_GUIDANCE_TTL_MS;
}

/** 仅在本轮回复真实播出（onDone 且未被火山 abort）后调用。 */
export function markSoloGuidanceSent(tenantId: string | undefined, now = Date.now()): void {
  if (tenantId) soloGuidanceLastSentAt.set(tenantId, now);
}

/** 测试专用。 */
export function _resetGuidanceState(): void {
  guidancePending.clear();
  guidanceLastSentAt.clear();
  soloGuidanceLastSentAt.clear();
}
