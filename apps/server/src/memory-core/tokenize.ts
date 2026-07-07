/**
 * jieba-wasm 分词封装（memory-core 唯一外部依赖）。
 *
 * 选型依据（2026-07-07 探针实测）：jieba-wasm 2.4.0 在 Node 22 下 init 5ms、
 * 千次分词 7ms、内存增量 ~10MB；同包带 web 构建，R2 App 侧（WKWebView）可复用
 * 同一实现保证两端分词一致。详见 docs/memory-architecture.md §4.1/§7。
 *
 * 注意：jieba-wasm 的 node 构建是 CJS（pkg/nodejs），ESM 下用默认导入再解构。
 */
import jieba from 'jieba-wasm';
import { STOPWORDS, QUERY_EXTRA_STOPWORDS } from './stopwords.js';

const { cut_for_search } = jieba as unknown as {
  cut_for_search: (text: string, hmm: boolean) => string[];
};

/** 词是否值得进索引：≥2 字中文整词，或 ≥2 位字母/数字串（单字/单字符全是噪音）。 */
function isIndexable(token: string): boolean {
  if (token.length < 2) return false;
  if (/^[\s\p{P}]+$/u.test(token)) return false;
  return /[一-龥A-Za-z0-9]/.test(token);
}

/**
 * 文档侧分词：cut_for_search（细粒度，长词同时吐子词，如"周杰伦"→周杰伦；
 * "降压药"→降压/降压药）→ 停用词过滤 → 去重。
 */
export function tokenizeDoc(text: string): string[] {
  if (!text || !text.trim()) return [];
  const out = new Set<string>();
  for (const token of cut_for_search(text, true)) {
    if (!isIndexable(token)) continue;
    if (STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return [...out];
}

/** query 侧分词：文档侧规则 + 叙述引导词额外过滤。 */
export function tokenizeQuery(text: string): string[] {
  return tokenizeDoc(text).filter((token) => !QUERY_EXTRA_STOPWORDS.has(token));
}

/** 启动预热：首次分词触发 wasm 词典加载（~5ms），避免摊在首轮通话上。 */
export function warmupTokenizer(): void {
  cut_for_search('预热分词器', true);
}
