/**
 * 关键词打分：IDF-local + recency 衰减 + 置信权重。
 *
 * 为什么不是真 BM25：BM25 的 TF 饱和/长度归一在「几十字短记忆 × 几百条量级」
 * 下无区分度（每条记忆里 token 几乎只出现一次），预训练 IDF 参数表（腾讯
 * tcvdb-text 方案）则引入 3MB+ 词表依赖。IDF 从 owner 自己的记忆集合现算
 * （N≤2000，毫秒级），语料即语域，区分度反而更贴身。
 */
import { tokenizeDoc } from './tokenize.js';
import type { RecallDoc, ScoredDoc } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 老记忆衰减地板：三个月前的事实仍保留 20% 权重，不清零（长期语义记忆的意义所在）。 */
const RECENCY_FLOOR = 0.2;

export function recencyBoost(createdAt: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now - createdAt) / DAY_MS);
  return Math.max(RECENCY_FLOOR, Math.exp((-Math.LN2 * ageDays) / halfLifeDays));
}

/**
 * 对候选集打分。O(N × 平均token数)：N=2000 时全程 ~15ms（分词占大头），
 * 在 recall 热路径预算内（telemetry memoryReadMs 持续监控）。
 */
export function scoreDocs(
  queryTokens: string[],
  docs: RecallDoc[],
  opts: { now: number; halfLifeDays: number },
): ScoredDoc[] {
  if (queryTokens.length === 0 || docs.length === 0) return [];

  const docTokens = docs.map((doc) => new Set(tokenizeDoc(doc.text)));

  // IDF-local：df 只统计 query token 在候选集中的文档频次
  const idf = new Map<string, number>();
  const n = docs.length;
  for (const token of queryTokens) {
    let df = 0;
    for (const tokens of docTokens) if (tokens.has(token)) df += 1;
    idf.set(token, Math.log((n + 1) / (df + 1)) + 1);
  }

  const scored: ScoredDoc[] = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const tokens = docTokens[i]!;
    let keywordScore = 0;
    const matched: string[] = [];
    for (const token of queryTokens) {
      if (tokens.has(token)) {
        keywordScore += idf.get(token) ?? 0;
        matched.push(token);
      }
    }
    if (keywordScore <= 0) continue;
    const salience =
      keywordScore * recencyBoost(doc.createdAt, opts.now, opts.halfLifeDays) * (doc.confidenceWeight ?? 1.0);
    scored.push({ doc, keywordScore, salience, matched });
  }
  return scored;
}
