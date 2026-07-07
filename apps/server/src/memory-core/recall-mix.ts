/**
 * 混合召回策略：相关性 top-K + 最近保底 + 去重。
 *
 * 为什么要保底位：纯相关性会漏"刚说过但换了说法的事"（分词不重叠），
 * 纯 recency 会漏"三周前说的关键事实"（本次升级要修的主病）——两路互补。
 * 为什么有退化信号：query 无有效 token / 全零命中时返回 picked=null，
 * 调用方完全退回原行为——最坏情况严格等于升级前，零回归风险。
 */
import { tokenizeQuery } from './tokenize.js';
import { scoreDocs } from './score.js';
import type { MixRecallOptions, MixRecallResult, PickedDocDetail, RecallDoc } from './types.js';

export function mixRecall(query: string, docs: RecallDoc[], options: MixRecallOptions = {}): MixRecallResult {
  const relevantK = options.relevantK ?? 5;
  const recentK = options.recentK ?? 3;
  const cap = options.cap ?? 8;
  const halfLifeDays = options.halfLifeDays ?? 30;
  const now = options.now ?? Date.now();

  const degraded: MixRecallResult = { picked: null, matchedKeywords: [], relevantCount: 0, details: [] };
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return degraded;

  const scored = scoreDocs(queryTokens, docs, { now, halfLifeDays });
  if (scored.length === 0) return degraded;

  scored.sort((a, b) => b.salience - a.salience || b.doc.createdAt - a.doc.createdAt);
  const relevant = scored.slice(0, relevantK);
  const pickedIds = new Set(relevant.map((s) => s.doc.id));

  // recency 保底：从全集按时间补足，跳过已选
  const recentPool = [...docs].sort((a, b) => b.createdAt - a.createdAt);
  const fillers: RecallDoc[] = [];
  for (const doc of recentPool) {
    if (fillers.length >= recentK) break;
    if (pickedIds.has(doc.id)) continue;
    pickedIds.add(doc.id);
    fillers.push(doc);
  }

  const picked = [...relevant.map((s) => s.doc), ...fillers].slice(0, cap);
  const details: PickedDocDetail[] = picked.map((doc): PickedDocDetail => {
    const hit = relevant.find((s) => s.doc.id === doc.id);
    return hit
      ? { id: doc.id, source: 'relevant', matched: hit.matched, keywordScore: hit.keywordScore, salience: hit.salience }
      : { id: doc.id, source: 'recent', matched: [], keywordScore: 0, salience: 0 };
  });
  const matchedKeywords = [...new Set(relevant.flatMap((s) => s.matched))];
  return { picked, matchedKeywords, relevantCount: Math.min(relevant.length, picked.length), details };
}
