/**
 * 隐私记忆分类器（R2，docs/memory-architecture.md §4.2）——判定一条结构化记忆
 * 是否应路由到用户本机 vault 而非云端落盘。两端共用（server 写入路由 / App 展示）。
 *
 * 三层锚点，宁多勿漏（误路由的代价=换台电脑看不到这条记忆；漏路由的代价=隐私落云端盘）：
 * 1. type 全量：safety / location / relationship（含将来抽取器新增产出，向前兼容）
 * 2. key 锚点：profile.address / profile.phone 等明确敏感 key
 *    （profile.name 刻意不进：低敏且用于称呼一致性，路由走会伤体验）
 * 3. 内容词表兜底：健康/财务/证件/联系方式类词，扫 key+value+原话
 */

export const PRIVACY_TYPES: ReadonlySet<string> = new Set(['safety', 'location', 'relationship']);

const PRIVACY_KEY_PREFIXES = ['profile.address', 'profile.phone', 'profile.id', 'profile.bank', 'profile.salary'];

// 内容敏感词（整词出现即命中；配合 jieba 无关——直接子串匹配，词表词长≥2 误报可控）
const SENSITIVE_CONTENT_WORDS = [
  // 健康
  '过敏', '医院', '确诊', '手术', '血压', '血糖', '化疗', '抑郁', '病史', '药量', '剂量', '体检报告',
  // 财务
  '工资', '月薪', '年薪', '存款', '贷款', '房贷', '车贷', '欠款', '密码', '账号',
  // 证件
  '身份证', '护照', '银行卡', '社保号', '驾照',
  // 联系方式/位置
  '手机号', '住址', '家庭地址', '门牌',
];

export interface PrivacyClassifyInput {
  type: string;
  key: string;
  value: string;
  /** ASR 原话片段（可选，兜底扫描面更全）。 */
  sourceSpan?: string;
}

export interface PrivacyClassifyResult {
  isPrivate: boolean;
  /** 命中依据（治理面板改判/审计展示用；不含记忆内容本身）。 */
  reason?: 'type' | 'key' | 'keyword';
  hit?: string;
}

/** 整句敏感预判（审计/事件日志脱敏用）：只走词表层，不需要 type/key。 */
export function hasSensitiveContent(text: string): boolean {
  if (!text) return false;
  return SENSITIVE_CONTENT_WORDS.some((word) => text.includes(word));
}

export function classifyPrivacy(input: PrivacyClassifyInput): PrivacyClassifyResult {
  if (PRIVACY_TYPES.has(input.type)) {
    return { isPrivate: true, reason: 'type', hit: input.type };
  }
  const key = input.key ?? '';
  for (const prefix of PRIVACY_KEY_PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}.`)) {
      return { isPrivate: true, reason: 'key', hit: prefix };
    }
  }
  const haystack = `${key} ${input.value ?? ''} ${input.sourceSpan ?? ''}`;
  for (const word of SENSITIVE_CONTENT_WORDS) {
    if (haystack.includes(word)) {
      return { isPrivate: true, reason: 'keyword', hit: word };
    }
  }
  return { isPrivate: false };
}
