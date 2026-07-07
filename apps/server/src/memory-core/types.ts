/**
 * memory-core 核心类型。
 *
 * 设计约束：本目录零 server 耦合（不 import server 任何模块）——按共享包界面
 * 设计，R2 App 侧接入时抽为 packages/memory-core（见 docs/memory-architecture.md §6 R1 说明）。
 * 调用方负责把自己的记忆结构适配成 RecallDoc。
 */

/** 记忆生命周期分层（R1 仅类型先行，晋升逻辑 R3/R4 启用）。 */
export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'profile';

/** 参与相关性召回的文档抽象。 */
export interface RecallDoc {
  id: string;
  /** 已拼好的索引文本（调用方决定拼什么，如 key + value + 原话片段）。 */
  text: string;
  /** 摄入时间（epoch ms），用于 recency 衰减与保底排序。 */
  createdAt: number;
  /**
   * 置信权重（0~1]，调用方从自己的状态体系换算（如 committed=1.0 / provisional=0.7）。
   * 缺省 1.0。
   */
  confidenceWeight?: number;
}

export interface ScoredDoc {
  doc: RecallDoc;
  /** 关键词得分（Σ 命中 token 的 IDF），0 = 无命中。 */
  keywordScore: number;
  /** 综合分 = keywordScore × recency × confidenceWeight。 */
  salience: number;
  /** 命中的 query token（telemetry / 可解释性）。 */
  matched: string[];
}

export interface MixRecallOptions {
  /** 相关性位名额（默认 5）。 */
  relevantK?: number;
  /** 最近保底位名额（默认 3）。 */
  recentK?: number;
  /** 合并去重后的总上限（默认 8）。 */
  cap?: number;
  /** recency 半衰期（天，默认 30）。 */
  halfLifeDays?: number;
  /** 当前时间（epoch ms），测试注入用；缺省 Date.now()。 */
  now?: number;
}

export interface MixRecallResult {
  /**
   * null = 相关性召回不适用（query 无有效 token 或全零命中），
   * 调用方应完全退回原有召回行为。
   */
  picked: RecallDoc[] | null;
  /** 全部被选中文档命中过的 query token（去重），退化时为空数组。 */
  matchedKeywords: string[];
  /** picked 里来自相关性位的数量（其余为 recency 保底位）。 */
  relevantCount: number;
}
