/**
 * Prompt 组装 —— 分层叠加（抽取自 P003 prompt-orchestrator，剥离小可业务）。
 *
 * P003 的层：世界观基座 + 安全基线 + 课程护栏 + AI 启蒙 + 画像记忆 + 知识召回 + 吐槽后缀。
 * MyJavis 通用化为：人设基座 + 安全基线 + 记忆注入。业务层（工具、领域知识）按需再加。
 *
 * ⚠️ P003 教训（feedback_p003_recency_rule）：「本轮任务」类指令必须放 prompt 最末尾，
 *    否则被前面的人设/记忆盖过（近因效应）。本组装器保证 taskSuffix 永远在最后。
 */

import type { MemoryFragment } from '../memory/types.js';

/** 通用助手人设基座占位 —— 待 docs/PRODUCT-DEFINITION.md §2 替换 */
export const PERSONA_BASE = `你是 MyJavis，一个实时语音助手。回答简洁、口语化、自然，适合朗读。
（人设占位：语气 / 称呼 / 风格待产品定义。）`;

/** 通用安全基线占位 */
export const SAFETY_BASELINE = `不输出有害、违法或泄露隐私的内容；不确定的事实如实说不知道，不编造。`;

export interface AssembleArgs {
  persona?: string;
  safety?: string;
  /** 注入的记忆片段（来自 MemoryStore.recall） */
  memories?: MemoryFragment[];
  /** 本轮任务/指令（如开场白触发），必须置于最末尾（近因） */
  taskSuffix?: string;
}

export function assemblePrompt(args: AssembleArgs = {}): string {
  const parts: string[] = [];
  parts.push(args.persona ?? PERSONA_BASE);
  parts.push(args.safety ?? SAFETY_BASELINE);

  if (args.memories && args.memories.length > 0) {
    const lines = args.memories.map((m) => `- [${m.kind}] ${m.text}`).join('\n');
    parts.push(`关于用户你已知道（记忆）：\n${lines}`);
  }

  // 近因规则：taskSuffix 永远最后
  if (args.taskSuffix) {
    parts.push(args.taskSuffix);
  }

  return parts.join('\n\n');
}
