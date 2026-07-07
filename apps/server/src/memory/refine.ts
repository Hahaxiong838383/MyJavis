/**
 * R3 记忆批处理精修器（mem0 V3 模式移植，docs/memory-architecture.md §5.2）。
 *
 * 定位：规则式 admission 即时落库（零延迟）之上的"事后精修层"——语义级合并/去重/
 * 矛盾失效是规则做不了的（"我不喝咖啡了"要把旧的"喜欢冰美式"判废）。
 * 节奏：定时 tick（默认 10min）扫"有新记忆的 owner"攒批跑，绝不在通话热路径；
 * 单次 LLM 调用完成全部决策（全场最省 token 的写入决策形态）。
 * 防幻觉：记忆用整数编号映射（mem0 anti-hallucination 模式 + 自家 uuid_misroute 教训），
 * LLM 输出的编号不在映射表内即丢弃该决策。
 * 隐私：只作用云端记忆（敏感记忆已被 R2 路由走），零新增暴露面。
 * 可观测：每次精修 push activity（川哥要求：运行机制 App 实时可见）+ audit kind=refine。
 */
import { createLlm } from '../providers/llm.js';
import { pushActivity } from '../activity/feed.js';
import type { SQLiteMemoryStorage } from './storage.js';
import type { MemoryItem } from './types.js';
import type { LlmProvider } from '../providers/types.js';

const TICK_MS = Number(process.env.MEMORY_REFINE_TICK_MS ?? 10 * 60_000);
const ENABLED = process.env.MEMORY_REFINE_ENABLED !== '0';
/** 每 owner 每批最多带的新记忆数（prompt 规模保护）。 */
const BATCH_CAP = 10;
/** 攒批阈值：新记忆不足此数不跑（省调用）。 */
const MIN_BATCH = 2;

export interface RefineAction {
  action: 'INVALIDATE' | 'MERGE' | 'NONE';
  /** 被处理的记忆编号（映射表内的整数）。 */
  target: number;
  /** MERGE 时：保留哪条（编号）。 */
  keep?: number;
  /** MERGE 时：保留条的新 value（合并后的表述）。 */
  value?: string;
  reason?: string;
}

const SYSTEM_PROMPT = `你是个人语音助手的记忆库管理员。给你一位用户的「新记忆」和「相关旧记忆」清单（每条有编号）。
判断并输出 JSON 决策数组，动作只有三种：
- INVALIDATE：某条旧记忆已被新记忆在语义上取代/否定（如新说"不喝咖啡了"则旧的"喜欢冰美式"失效），target=旧记忆编号
- MERGE：两条记忆是同一件事的重复表述，keep=保留编号，target=被合并编号，value=合并后的简洁表述（≤30字）
- 无需处理则不输出该条（不要输出 NONE 填充）
规则：宁少勿多，拿不准就不动；只能引用清单里存在的编号；绝不虚构。
输出格式（只输出 JSON，无其他文字）：{"actions":[{"action":"INVALIDATE","target":3,"reason":"..."}]}`;

function buildUserPrompt(fresh: Array<[number, MemoryItem]>, related: Array<[number, MemoryItem]>): string {
  const fmt = ([n, m]: [number, MemoryItem]) =>
    `${n}. [${m.type}] ${m.content.key}=${m.content.value}（${new Date(m.createdAt).toISOString().slice(0, 10)}）`;
  return [
    '## 新记忆（最近说的）',
    ...fresh.map(fmt),
    '',
    '## 相关旧记忆',
    related.length ? related.map(fmt).join('\n') : '（无）',
  ].join('\n');
}

/** 收集流式 LLM 全文（精修不需要流式，但复用现有双 provider 赛马通道）。 */
async function completeOnce(llm: LlmProvider, systemPrompt: string, userText: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    llm
      .streamChat({
        systemPrompt,
        userText,
        history: [],
        onDelta: () => {},
        onDone: (full) => resolve(full),
        onError: (err) => reject(err),
      })
      .catch(reject);
  });
}

function parseActions(raw: string): RefineAction[] {
  try {
    const jsonText = raw.replace(/```json|```/g, '').trim();
    const match = /\{[\s\S]*\}/.exec(jsonText);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { actions?: unknown };
    if (!Array.isArray(parsed.actions)) return [];
    return parsed.actions.filter(
      (a): a is RefineAction =>
        Boolean(a) &&
        typeof (a as RefineAction).target === 'number' &&
        ((a as RefineAction).action === 'INVALIDATE' || (a as RefineAction).action === 'MERGE'),
    );
  } catch {
    return [];
  }
}

export class MemoryRefiner {
  /** owner → 上次精修时间戳（内存态；重启重扫无害，精修幂等）。 */
  private readonly lastRefined = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: SQLiteMemoryStorage,
    private readonly llm: LlmProvider = createLlm(),
    private readonly tenantForOwner: (ownerId: string) => string | undefined = () => undefined,
  ) {}

  start(): void {
    if (!ENABLED) {
      console.log('[refine] disabled (MEMORY_REFINE_ENABLED=0)');
      return;
    }
    this.timer = setInterval(() => void this.tickOnce().catch((err) => console.error('[refine] tick error:', err)), TICK_MS);
    console.log(`[refine] scheduler started (tick ${Math.round(TICK_MS / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 扫一轮全部有新记忆的 owner（测试可直接调）。 */
  async tickOnce(now = Date.now()): Promise<void> {
    if (this.running) return; // 上一轮未完成（LLM 慢）：跳过防重入
    this.running = true;
    try {
      for (const ownerId of this.db.listOwnerIdsWithMemories()) {
        await this.refineOwner(ownerId, now).catch((err) => {
          console.error(`[refine] owner=${ownerId} error:`, err instanceof Error ? err.message : err);
        });
      }
    } finally {
      this.running = false;
    }
  }

  async refineOwner(ownerId: string, now = Date.now()): Promise<{ applied: number; considered: number } | null> {
    const since = this.lastRefined.get(ownerId) ?? 0;
    // 新记忆：上次精修后写入、活跃可见的（quarantine/失效/暂停都不碰）
    const fresh = this.db
      .listRecallCandidates(ownerId, 100)
      .filter((item) => item.createdAt > since)
      .slice(0, BATCH_CAP);
    if (fresh.length < MIN_BATCH) return null;

    // 相关旧记忆：新记忆各自 dimension 的既有条目（去重、排除 fresh 自身）
    const freshIds = new Set(fresh.map((item) => item.id));
    const related: MemoryItem[] = [];
    const seen = new Set<string>();
    for (const item of fresh) {
      for (const old of this.db.listMemoryByDimension(ownerId, item.content.key, 10)) {
        if (freshIds.has(old.id) || seen.has(old.id)) continue;
        seen.add(old.id);
        related.push(old);
      }
    }

    // 整数编号映射（防幻觉）
    const numbered = new Map<number, MemoryItem>();
    let n = 1;
    const freshNumbered: Array<[number, MemoryItem]> = fresh.map((item) => {
      numbered.set(n, item);
      return [n++, item];
    });
    const relatedNumbered: Array<[number, MemoryItem]> = related.map((item) => {
      numbered.set(n, item);
      return [n++, item];
    });

    const raw = await completeOnce(this.llm, SYSTEM_PROMPT, buildUserPrompt(freshNumbered, relatedNumbered));
    const actions = parseActions(raw);
    this.lastRefined.set(ownerId, now);

    let applied = 0;
    const tenantId = this.tenantForOwner(ownerId);
    for (const action of actions) {
      const target = numbered.get(action.target);
      if (!target) continue; // 编号不在映射表：LLM 幻觉，丢弃
      if (action.action === 'INVALIDATE') {
        applied += this.db.invalidateMemoryItems([target.id], now);
      } else if (action.action === 'MERGE') {
        const keep = action.keep !== undefined ? numbered.get(action.keep) : undefined;
        if (!keep || keep.id === target.id) continue;
        if (action.value && action.value.trim()) {
          this.db.updateMemoryItem({ ...keep, content: { ...keep.content, value: action.value.trim().slice(0, 120) } });
        }
        applied += this.db.invalidateMemoryItems([target.id], now);
      }
      this.db.insertAudit({
        id: `refine_${target.id}_${now}`,
        ts: now,
        ownerId,
        kind: 'refine',
        decision: { action: action.action, reason: action.reason ?? '' },
        rationale: action.action.toLowerCase(),
        signal: { memoryId: target.id, keep: action.keep !== undefined ? numbered.get(action.keep)?.id : undefined },
      });
    }

    if (applied > 0) {
      pushActivity(tenantId, {
        kind: 'refine',
        summary: `记忆精修完成：${fresh.length} 条新记忆核对，${applied} 条旧记忆被合并/更新`,
        detail: { considered: fresh.length, applied },
      });
      console.log(`[refine] owner=${ownerId} considered=${fresh.length} applied=${applied}`);
    }
    return { applied, considered: fresh.length };
  }
}
