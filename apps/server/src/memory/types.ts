/**
 * 记忆系统接口 —— ⬜ 占位，等产品定义。
 *
 * P003 的记忆是两层：L0 会话历史（pipeline 成员，断开即丢）+ L1 SQLite 长期画像
 * （nickname/interests/personality 等，异步 LLM 每 N 轮抽取）。
 *
 * MyJavis「记什么、怎么用、存哪、是否遗忘」强依赖产品定义，故这里只定最小接口，
 * 实现（CQRS / EvoMap / SQLite）待 docs/PRODUCT-DEFINITION.md §3 落地后再选。
 */

import type { ChatTurn } from '../providers/types.js';

/** 一条注入 LLM 的记忆片段（结构待产品定义细化） */
export interface MemoryFragment {
  kind: string; // 如 'preference' | 'fact' | 'profile' …待定义
  text: string;
  confidence?: number;
  updatedAt?: number;
}

export interface RecallQuery {
  userId: string;
  /** 本轮用户输入，供语义/关键词检索 */
  userText: string;
  limit?: number;
}

export interface MemoryStore {
  /** 取要注入本轮 prompt 的记忆（最近 N / 向量 / 关键词，由实现决定） */
  recall(q: RecallQuery): Promise<MemoryFragment[]>;

  /** 从一段对话异步抽取并写入记忆（P003 是每 N 轮跑一次，超时不阻塞语音） */
  extractAndWrite(userId: string, recentTurns: ChatTurn[]): Promise<void>;
}

/** 空实现：不记忆、不抽取。骨架默认装它，跑通链路用；产品定义后替换。 */
export class NullMemoryStore implements MemoryStore {
  async recall(): Promise<MemoryFragment[]> {
    return [];
  }
  async extractAndWrite(): Promise<void> {
    /* no-op，待产品定义 */
  }
}
