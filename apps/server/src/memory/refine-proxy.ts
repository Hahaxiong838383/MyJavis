/**
 * R4 提炼代理核心逻辑（docs/memory-architecture.md §4.4「默认档·server 代理」）。
 *
 * 定位：App 本机隐私 vault 攒够一批候选记忆 → server 转发现有 LLM 通道做 mem0 V3 式
 * 单次决策（复用 memory/refine.ts 的 prompt 设计与 LLM 调用方式，见该文件头注）→
 * 结构化 ADD/UPDATE/DELETE/NONE 决策 → 结果回本机由 App 落 vault。
 *
 * 隐私红线：本文件（以及调用方 routes/memory-refine.ts）全程只在内存里处理请求体，
 * 不写 DB、不写文件——纯函数式请求→LLM→响应，零落盘。
 *
 * 防幻觉：与 refine.ts 同款 mem0 anti-hallucination 模式——LLM 只认识本批次内的
 * 小整数编号（App 侧生成，通常是数组下标+1），决策引用的编号若不在本批次编号集合内
 * 直接丢弃（parseDecisions 的 validIds 校验）。
 */
import type { LlmProvider } from '../providers/types.js';
import { completeOnce } from './refine.js';

/** 单批上限（App 侧 pending+context 合计），routes/memory-refine.ts 在此之上再做 413 保护。 */
export const MAX_REFINE_BATCH_ITEMS = 50;

/**
 * App 端 vault 批次条目（与 apps/web/src/vault.ts 的 RefineBatchItem 同构，字段一一对应）。
 * id 由 App 生成，仅在本次请求/响应内有意义（server 全程零落盘，无法跨请求维护映射）。
 */
export interface RefineBatchItem {
  /** 批次内整数编号，App 侧生成且批次内唯一。 */
  id: number;
  /** pending=待提炼决策（LLM 需要为它输出一条决策）；context=只读参考（同批次相关旧记忆，不下发决策，仅供 LLM 比对）。 */
  role: 'pending' | 'context';
  /** vault memory type（preference / profile_fact / event / ...）。 */
  type: string;
  /** vault memory key（维度，用于展示与去重判断）。 */
  key: string;
  /** vault memory value（记忆内容原文）。 */
  value: string;
}

export type RefineAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';

export interface RefineDecision {
  /** 引用 RefineBatchItem.id（必然是某个 pending 条目）。 */
  id: number;
  action: RefineAction;
  /** UPDATE/DELETE 时引用的目标旧记忆编号（可以是另一条 pending 或一条 context）。 */
  mergeWithId?: number;
  /** UPDATE 时合并/清理后的新表述（≤120 字）。 */
  value?: string;
  reason?: string;
}

const SYSTEM_PROMPT = `你是个人语音助手的本机隐私记忆管理员。给你一批记忆候选，标 [新] 的是待处理条目、标 [旧] 的是同批次里仅供参考的既有记忆（不需要为 [旧] 输出决策）。
逐条判断每个 [新] 记忆的处理动作，输出 JSON 决策数组，动作只有四种：
- ADD：独立的新事实，跟任何 [旧]/其他 [新] 记忆都不重复也不冲突，原样保留
- UPDATE：应与某条 [旧] 或 [新] 记忆合并（同一维度的更新表述），mergeWithId=被更新的目标编号，value=合并后的简洁表述（≤60字）
- DELETE：与某条 [旧] 或 [新] 记忆语义完全重复（纯重复表达，无新增信息），mergeWithId=重复对象的编号
- NONE：拿不准，先不处理
规则：宁少勿多，拿不准就 NONE；id 必须是清单里 [新] 记忆的编号；mergeWithId 必须是清单里存在的编号；绝不虚构编号；只为每条 [新] 记忆各输出一条决策。
输出格式（只输出 JSON，无其他文字）：{"decisions":[{"id":1,"action":"ADD"},{"id":2,"action":"UPDATE","mergeWithId":1,"value":"...","reason":"..."}]}`;

function buildUserPrompt(items: RefineBatchItem[]): string {
  const fmt = (item: RefineBatchItem) => `${item.id}. [${item.role === 'pending' ? '新' : '旧'}][${item.type}] ${item.key}=${item.value}`;
  const pending = items.filter((item) => item.role === 'pending');
  const context = items.filter((item) => item.role === 'context');
  return [
    '## 待处理（新）',
    ...pending.map(fmt),
    '',
    '## 参考（旧，仅供比对，不需要为它们输出决策）',
    context.length ? context.map(fmt).join('\n') : '（无）',
  ].join('\n');
}

function parseDecisions(raw: string, validIds: Set<number>): RefineDecision[] {
  try {
    const jsonText = raw.replace(/```json|```/g, '').trim();
    const match = /\{[\s\S]*\}/.exec(jsonText);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { decisions?: unknown };
    if (!Array.isArray(parsed.decisions)) return [];
    const actions = new Set<RefineAction>(['ADD', 'UPDATE', 'DELETE', 'NONE']);
    const out: RefineDecision[] = [];
    for (const raw2 of parsed.decisions) {
      const d = raw2 as Partial<RefineDecision>;
      if (typeof d.id !== 'number' || !validIds.has(d.id)) continue; // 幻觉编号：丢弃
      if (typeof d.action !== 'string' || !actions.has(d.action as RefineAction)) continue;
      const mergeWithId = typeof d.mergeWithId === 'number' && validIds.has(d.mergeWithId) ? d.mergeWithId : undefined;
      out.push({
        id: d.id,
        action: d.action as RefineAction,
        mergeWithId,
        value: typeof d.value === 'string' && d.value.trim() ? d.value.trim().slice(0, 120) : undefined,
        reason: typeof d.reason === 'string' ? d.reason.slice(0, 200) : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 单次决策调用（非流式，全程内存）。items 为空 / 无 pending 条目时直接返回空数组不调 LLM
 * （省调用，也避免空 prompt 让 LLM 瞎编）。
 */
export async function refineBatch(items: RefineBatchItem[], llm: LlmProvider): Promise<RefineDecision[]> {
  const pendingIds = new Set(items.filter((item) => item.role === 'pending').map((item) => item.id));
  if (pendingIds.size === 0) return [];
  const validIds = new Set(items.map((item) => item.id));
  const raw = await completeOnce(llm, SYSTEM_PROMPT, buildUserPrompt(items));
  const decisions = parseDecisions(raw, validIds);
  // 只保留对 pending 条目的决策——LLM 若误给 context 编号出决策（不应该，但防御性丢弃）。
  return decisions.filter((d) => pendingIds.has(d.id));
}
