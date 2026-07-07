import type { CorrectionIntent, MemoryCandidate, MemoryType, StructuredMemoryContent } from './types.js';

export function isInstructionInjection(text: string): boolean {
  return /忽略.*(安全|规则|system|系统)|ignore.*(safety|rules|system)|越权|绕过权限|不要遵守/i.test(text);
}

export function extractCorrectionIntent(text: string): CorrectionIntent | null {
  const normalized = text.trim();
  if (/忘掉(这件事|刚才|这个|这条|上条|刚刚)/.test(normalized)) {
    return { action: 'delete', span: normalized };
  }
  if (/那是别人说的|不是我说的|别人说的/.test(normalized)) {
    return { action: 'reattribute', span: normalized };
  }
  const update = /不是[，,。 ]*(?:我说的是|应该是|是)(.+)$/.exec(normalized);
  if (update?.[1]?.trim()) {
    return { action: 'update', span: normalized, replacement: update[1].trim() };
  }
  return null;
}

/**
 * 疑问句防误抽（R3 实测危害升级）："我喜欢喝什么咖啡来着"被抽成 preference 会把
 * 真偏好顶掉（bi-temporal update 失效旧值）、"我对什么过敏"抽成 value=什么。
 * 提问是在「查」记忆不是在「说」事实——含疑问信号的整句不抽任何候选（宁漏勿误，
 * 真事实用户会用陈述句说）。
 */
const INTERROGATIVE_RE = /什么|啥|来着|吗[？?]?$|呢[？?]?$|[？?]$|怎么|哪(?:个|些|里|天)|几点|几号|多少|是不是|有没有/;

export function isInterrogative(text: string): boolean {
  return INTERROGATIVE_RE.test(text.trim());
}

export function extractMemoryCandidates(text: string, now = Date.now()): MemoryCandidate[] {
  const normalized = text.trim();
  if (!normalized || isInstructionInjection(normalized)) return [];
  if (isInterrogative(normalized)) return [];

  const candidates: MemoryCandidate[] = [];
  pushIf(candidates, extractSafety(normalized));
  pushIf(candidates, extractReminder(normalized, now));
  pushIf(candidates, extractEvent(normalized, now));
  pushIf(candidates, extractProfile(normalized));
  pushIf(candidates, extractPreference(normalized));

  if (candidates.length > 0) return dedupeCandidates(candidates);
  if (/^记住[:：]?\s*(.+)/.test(normalized) || /^以后[:：]?\s*(.+)/.test(normalized)) {
    return [
      makeCandidate({
        type: 'ephemeral_context',
        key: 'session.explicit_note',
        value: normalized.replace(/^(记住|以后)[:：]?\s*/, ''),
        span: normalized,
        salience: 0.45,
        ttl: 24 * 60 * 60 * 1000,
        validUntil: now + 24 * 60 * 60 * 1000,
      }),
    ];
  }
  return [];
}

export interface AmbiguousLlmEscalation {
  enabled: false;
  reason: 'mvp_deterministic_only';
}

export function maybeEscalateAmbiguousToLlm(): AmbiguousLlmEscalation {
  return { enabled: false, reason: 'mvp_deterministic_only' };
}

function extractSafety(text: string): MemoryCandidate | null {
  const allergy = /我对(.{1,30}?)(?:过敏|会过敏)/.exec(text);
  if (!allergy?.[1]) return null;
  const allergen = cleanupValue(allergy[1]);
  return makeCandidate({
    type: 'safety',
    key: 'safety.allergy',
    value: allergen,
    span: allergy[0],
    salience: 1,
  });
}

function extractReminder(text: string, now: number): MemoryCandidate | null {
  const reminder = /提醒我(.{1,80})/.exec(text);
  if (!reminder?.[1]) return null;
  return makeCandidate({
    type: 'reminder',
    key: 'task.reminder',
    value: cleanupValue(reminder[1]),
    span: reminder[0],
    salience: 0.85,
    ttl: 30 * 24 * 60 * 60 * 1000,
    validUntil: now + 30 * 24 * 60 * 60 * 1000,
  });
}

function extractEvent(text: string, now: number): MemoryCandidate | null {
  if (!/(航班|会议|日程|约了|预约)/.test(text)) return null;
  const eventWindow = 7 * 24 * 60 * 60 * 1000;
  return makeCandidate({
    type: 'event',
    key: eventDimension(text),
    value: text,
    span: text,
    salience: /航班|会议/.test(text) ? 0.95 : 0.8,
    ttl: eventWindow,
    validUntil: now + eventWindow,
  });
}

function extractProfile(text: string): MemoryCandidate | null {
  const address = /我(?:住在|住)(.{2,80})/.exec(text);
  if (address?.[1]) {
    return makeCandidate({
      type: 'profile_fact',
      key: 'profile.address',
      value: cleanupValue(address[1]),
      span: address[0],
      salience: 0.85,
      requiresConfirmation: true,
    });
  }
  const profile = /我的([^，。,：: ]{1,12})(?:是|叫)(.{1,80})/.exec(text);
  if (!profile?.[1] || !profile[2]) return null;
  return makeCandidate({
    type: 'profile_fact',
    key: `profile.${normalizeKey(profile[1])}`,
    value: cleanupValue(profile[2]),
    span: profile[0],
    salience: 0.8,
    requiresConfirmation: highRiskProfileKey(profile[1]),
  });
}

function extractPreference(text: string): MemoryCandidate | null {
  const preference = /我(不)?喜欢(.{1,60})/.exec(text);
  if (preference?.[2]) {
    const value = `${preference[1] ? '不喜欢' : '喜欢'}${cleanupValue(preference[2])}`;
    return makeCandidate({
      type: 'preference',
      key: preferenceDimension(preference[2]),
      value,
      span: preference[0],
      salience: 0.65,
    });
  }

  const future = /^以后(.{1,80})/.exec(text);
  if (future?.[1]) {
    return makeCandidate({
      type: 'preference',
      key: preferenceDimension(future[1]),
      value: cleanupValue(future[1]),
      span: future[0],
      salience: 0.6,
    });
  }

  const remember = /^记住[:：]?\s*(我(不)?喜欢.{1,60})/.exec(text);
  if (remember?.[1]) return extractPreference(remember[1]);
  return null;
}

function makeCandidate(args: {
  type: MemoryType;
  key: string;
  value: string;
  span: string;
  salience: number;
  ttl?: number;
  validUntil?: number;
  requiresConfirmation?: boolean;
}): MemoryCandidate {
  return {
    type: args.type,
    content: content(args.type, args.key, args.value),
    salience: args.salience,
    sourceSpan: args.span,
    dimension: args.key,
    ttl: args.ttl,
    validUntil: args.validUntil,
    requiresConfirmation: args.requiresConfirmation,
  };
}

function content(type: MemoryType, key: string, value: string): StructuredMemoryContent {
  return { kind: type, key, value, source: 'user_said' };
}

function pushIf(items: MemoryCandidate[], item: MemoryCandidate | null): void {
  if (item) items.push(item);
}

function dedupeCandidates(items: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.dimension}:${item.content.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanupValue(value: string): string {
  return value.replace(/[，。,.！!；;]$/g, '').trim();
}

function normalizeKey(value: string): string {
  if (/手机号|电话/.test(value)) return 'phone';
  if (/邮箱|email/i.test(value)) return 'email';
  if (/生日/.test(value)) return 'birthday';
  if (/地址/.test(value)) return 'address';
  return value.replace(/\s+/g, '_');
}

function highRiskProfileKey(value: string): boolean {
  return /手机号|电话|邮箱|地址|生日/.test(value);
}

function preferenceDimension(value: string): string {
  if (/冰美式|咖啡|拿铁|茶|饮料/.test(value)) return 'preference.drink';
  if (/辣|甜|咸|酸|口味/.test(value)) return 'preference.taste';
  if (/音乐|歌|播客/.test(value)) return 'preference.audio';
  return 'preference.general';
}

function eventDimension(value: string): string {
  if (/航班/.test(value)) return 'calendar.flight';
  if (/会议/.test(value)) return 'calendar.meeting';
  return 'calendar.event';
}
