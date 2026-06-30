/**
 * 记忆系统门面 —— ⬜ 当前装 NullMemoryStore 占位（川哥拍板：记忆先占位，等产品定义）。
 *
 * 这里是「接线缝」：custom-llm / pipeline 通过本单例调 recall / extractAndWrite，
 * 与具体实现解耦。产品定义（docs/PRODUCT-DEFINITION.md §3「记什么/怎么用/存哪/是否遗忘」）
 * 落地后，只需把下面这一行换成真实实现（如分层记忆：即时窗 + 结构化画像 + 向量语义召回），
 * 调用方零改动。
 *
 * 切换示例（产品定义后）：
 *   import { LayeredMemoryStore } from './layered.js';
 *   export const memory: MemoryStore = new LayeredMemoryStore(config.memory);
 */

import { NullMemoryStore, type MemoryStore } from './types.js';

export const memory: MemoryStore = new NullMemoryStore();

export type { MemoryStore, MemoryFragment, RecallQuery } from './types.js';
