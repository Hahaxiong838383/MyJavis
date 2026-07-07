/**
 * @myjavis/memory-core（目录形态，R2 抽包）
 *
 * 记忆检索与分层的共享内核：jieba 分词 + IDF-local 打分 + salience +
 * 混合召回。零 server 耦合（唯一外部依赖 jieba-wasm，同包带 web 构建，
 * R2 App 侧复用同一实现保证两端分词一致）。
 *
 * R1 为什么是目录不是 packages/：生产部署是「rsync dist + npm install」
 * 非 workspace 安装，独立包需要 file: 依赖改造部署链路——推迟到 R2 有
 * App 侧第二消费者时一并做。详见 docs/memory-architecture.md §6。
 */
export { tokenizeDoc, tokenizeQuery, warmupTokenizer } from './tokenize.js';
export { scoreDocs, recencyBoost } from './score.js';
export { mixRecall } from './recall-mix.js';
export type { MemoryLayer, RecallDoc, ScoredDoc, MixRecallOptions, MixRecallResult } from './types.js';
