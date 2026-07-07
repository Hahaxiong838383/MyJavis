/**
 * reminder 意图（custom-llm 短路，与声纹 enroll / 音乐同级范式）+ 对话会话状态机。
 *
 * 宁漏勿误（声纹 enroll 真机教训）：
 *  - SET 命中双规则：① 句子以「(时间)?(请/帮我/记得/到时候)?提醒我」形态开头；
 *    ② 句中含「提醒我」且全句有可解析的时间表达。
 *    → "我妈提醒我要吃饭"（叙述，无时间）不命中；"你能提醒我吗"不命中（LLM 自然接，
 *      用户下一句"三点提醒我开会"再命中）。
 *  - 缺件走反问状态机（awaiting_time / awaiting_content，90s TTL），不猜。
 *  - 设置成功 = 复述确认（"好，今天 15:00 提醒你：开会"）——复述是纠错窗口，可语音取消。
 */
import { formatDue, parseDateOnly, parseTimeExpr, parseTimeWithDateOffset, type ParsedTime } from './time-parse.js';

export { formatDue as fmtDue };

export type ReminderIntent =
  | { kind: 'set'; content: string; time: ParsedTime | null; dateOffset: number | null }
  | { kind: 'cancel' }
  | { kind: 'query' };

// 严格句首（白名单前缀词，"你能提醒我吗"这类疑问不命中——LLM 自然接，用户下句说全再命中）
const SET_HEAD_RE = /^\s*(?:请|帮我|记得|麻烦|到时候|然后|回头)?\s*提醒(?:一下)?我/;
const SET_ANY_RE = /提醒(?:一下)?我/;
const CANCEL_RE = /(?:别|不用|不要|取消|删掉|删除)(?:那个|这个|刚才的?|上一个)?\s*(?:提醒|闹钟)|(?:提醒|闹钟)\s*(?:取消|删掉|不用)/;
const QUERY_RE = /(?:有什么|有哪些|有没有|查查|查一下|看看|说说|我的)\s*提醒|提醒\s*(?:有什么|有哪些|列表)/;

/** 语气尾词/标点清理。 */
function cleanTail(s: string): string {
  return s
    .replace(/^[，。,.!！?？\s的地]+/, '')
    .replace(/[吧呀啊哦呢哈哟嘛吗呗啦咯哇~！!。.，,?？\s]+$/, '')
    .trim();
}

/** 从原句剥出提醒内容：去掉时间片段 + 「提醒我」引导 + 引导残留词。 */
function extractContent(text: string, timeMatched: string | null): string {
  let s = text;
  if (timeMatched) s = s.replace(timeMatched, ' ');
  s = s.replace(/(?:请|帮我|记得|麻烦|到时候|然后)?\s*提醒(?:一下)?我(?:一下)?/, ' ');
  s = s.replace(/^[\s，。,]*(?:要|得|去|说|记得)\s*/, ' ');
  return cleanTail(s.replace(/\s+/g, ' '));
}

export function detectReminderIntent(text: string): ReminderIntent | null {
  const t = text.trim();
  if (!t) return null;
  // 顺序：取消/查询先于设置（"取消刚才的提醒"含"提醒"，别落进 set）
  if (CANCEL_RE.test(t)) return { kind: 'cancel' };
  if (QUERY_RE.test(t)) return { kind: 'query' };

  const time = parseTimeExpr(t);
  const dateOnly = time ? null : parseDateOnly(t);
  const headHit = SET_HEAD_RE.test(t);
  const anyHit = SET_ANY_RE.test(t);
  // 命中双规则：① 严格句首形态；② 句中"提醒我"+有时间信号（"三点提醒我开会"/"明天提醒我交报告"）
  if (!headHit && !(anyHit && (time || dateOnly))) return null;

  const content = extractContent(t, time?.matched ?? dateOnly?.matched ?? null);
  return { kind: 'set', content, time, dateOffset: dateOnly?.dateOffset ?? null };
}

// ---------- 反问会话状态机（内存态，单进程；仿 enroll-session） ----------

export type ReminderSessionState = 'awaiting_time' | 'awaiting_content';

export interface ReminderSession {
  roomId: string;
  state: ReminderSessionState;
  content: string; // awaiting_time 时已有的内容（可空=时间到手后还要问内容）
  dueAt?: number; // awaiting_content 时已定的时间
  display?: string;
  dateOffset: number; // "明天提醒我交报告" → 1，反问"几点"后的回答继承
  retries: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 90_000;
const sessions = new Map<string, ReminderSession>();

export function getReminderSession(roomId: string | undefined): ReminderSession | undefined {
  if (!roomId) return undefined;
  const s = sessions.get(roomId);
  if (!s) return undefined;
  if (Date.now() > s.expiresAt) {
    sessions.delete(roomId);
    return undefined;
  }
  return s;
}

export function startAwaiting(roomId: string, init: Partial<Pick<ReminderSession, 'content' | 'dueAt' | 'display' | 'dateOffset'>> & { state: ReminderSessionState }): ReminderSession {
  const s: ReminderSession = {
    roomId,
    state: init.state,
    content: init.content ?? '',
    dueAt: init.dueAt,
    display: init.display,
    dateOffset: init.dateOffset ?? 0,
    retries: 0,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(roomId, s);
  return s;
}

export function bumpRetry(roomId: string): boolean {
  const s = sessions.get(roomId);
  if (!s) return false;
  s.retries += 1;
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return s.retries <= 2;
}

export function clearReminderSession(roomId: string): void {
  sessions.delete(roomId);
}

export function isReminderCancelWord(text: string): boolean {
  return /算了|不用了|不设了|取消|先不/.test(text.trim());
}

/** awaiting_time 状态的回答解析（继承 dateOffset）。 */
export function parseAwaitedTime(text: string, session: ReminderSession): ParsedTime | null {
  return parseTimeWithDateOffset(text, session.dateOffset);
}

/** awaiting_content 状态的回答 → 内容（拒明显不像事项的）。 */
export function parseAwaitedContent(text: string): string | null {
  const c = cleanTail(text).replace(/^(?:提醒我|就是|嗯|啊|哦)\s*/, '');
  if (!c || c.length > 60) return null;
  if (/^(?:什么|啥|为什么|不知道)/.test(c)) return null;
  return c;
}

// ---------- 话术（server 直出） ----------

export function setOkLine(display: string, content: string): string {
  return `好，${display}提醒你：${content}。`;
}
export function askTimeLine(content: string): string {
  return content ? `好，什么时候提醒你${content.length <= 12 ? content : ''}？` : '好，什么时候提醒你？';
}
export function askContentLine(display: string): string {
  return `好，${display}到点我提醒你什么？`;
}
export function askBothLine(): string {
  return '好呀，几点提醒你、提醒什么事？';
}
export function timeRetryLine(): string {
  return '没听清时间，可以说"十分钟后"，或者"明天早上八点"这样。';
}
export function contentRetryLine(): string {
  return '没听清要提醒的事，再说一遍？';
}
export function giveUpLine(): string {
  return '那先不设了，想提醒的时候随时说。';
}
export function cancelOkLine(content: string, display: string): string {
  return `好，取消了${display}那条「${content.length > 16 ? `${content.slice(0, 16)}…` : content}」的提醒。`;
}
export function cancelEmptyLine(): string {
  return '现在没有待办的提醒呢。';
}
export function queryEmptyLine(): string {
  return '现在没有设置中的提醒。';
}

/** 触达播报文（RTC 插播 / App 念出共用）。 */
export function fireLine(speakerName: string | undefined, content: string): string {
  const who = speakerName ? `${speakerName}，` : '';
  return `${who}提醒时间到了：${content}。`;
}

/** 补报文（下次通话 contextNote 注入让 LLM 自然带出用的原始材料）。 */
export function makeupNote(items: Array<{ display: string; content: string }>): string {
  const list = items.map((i, n) => `${n + 1}. ${i.display}的「${i.content}」`).join('；');
  return (
    `[系统提示] 有 ${items.length} 条用户之前设置的提醒在 TA 不在时到期了：${list}。` +
    `请在本轮回复开头自然地主动告知（比如"对了，你之前让我提醒你…"），不要提"系统/错过/离线"这类机制词。`
  );
}
