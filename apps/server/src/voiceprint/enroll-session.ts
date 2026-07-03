/**
 * 声纹「对话式注册」会话状态机（批次2）。
 *
 * 流程：用户说「我是X，记住我」→ custom-llm 意图命中 → startEnroll(room, X) + 直出引导语
 * → 前端轮询 /api/voiceprint/pending 发现 recording → 旁路录音（用户继续自然说话，
 * server 对该房间的 LLM 回复短路成倾听哼声，避免 TTS 长回复污染录音）→ 录满上传
 * register(带 roomId) → completeEnroll + ExternalTextToSpeech 播报成功。
 *
 * 状态存内存（单进程 pm2，重启丢失=用户再说一遍，可接受）。
 */

export type EnrollState = 'awaiting_name' | 'recording' | 'done' | 'failed';

export interface EnrollSession {
  roomId: string;
  displayName: string; // awaiting_name 阶段为空串
  state: EnrollState;
  attempt: number; // 录音上传尝试次数（火山拒后可重试，≤MAX_ATTEMPTS）
  nameRetries: number; // awaiting_name 阶段没听出名字的追问次数（超限放弃，防吞掉所有对话）
  createdAt: number;
  expiresAt: number;
  lastError?: string;
}

const SESSION_TTL_MS = 120_000; // 引导+录音+上传全程窗口；超时自动作废（用户再说一遍）
const RETRY_TTL_MS = 90_000; // 失败重录窗口
export const MAX_ATTEMPTS = 2;

const sessions = new Map<string, EnrollSession>();

/**
 * 意图识别（2026-07-03 真机日志校准：川哥说的是「记住我的声音」「我是谁？记住我的声音」这类
 * 自然表达，旧版只认「我是X，记住我」全部漏掉 → 声纹从未注册成功。现分两级）：
 *
 * ① 带名意图：「我是X，记住我 / 记住我的声音」。防误触发三件套保留（名字位排除"不是/就是/也是"、
 *    "记住我"后禁"的"、句末锚定），尾部放宽到确认式（好不好/行不行/可以吗）。
 * ② 无名意图：「记住我的声音 / 记一下我的声音 / 能记住我的声音吗」→ 进 awaiting_name，
 *    Javis 反问名字（用户不需要背句式，这是修复的关键）。
 */
export type EnrollIntent = { kind: 'named'; displayName: string } | { kind: 'unnamed' };

const TAIL =
  '[吧呀啊哦呢哈哟嘛吗呗啦咯哇~！!。.，,?？\\s]*(?:好不好|行不行|可以吗|能不能|好吗)?[吧呀啊哦呢哈哟嘛吗呗啦咯哇~！!。.，,?？\\s]*$';
const NAMED_RE = new RegExp(
  `(?:我是|我叫)\\s*(?!不是|就是|也是)([一-龥A-Za-z0-9·]{1,8}?)\\s*[,，。!！]?\\s*(?:记住我的声音|请?(?:记住|记一下|记录|认识)(?:一下)?我(?!的))${TAIL}`,
);
const UNNAMED_RE = new RegExp(`(?:请|帮我|能不能|能|可以)?\\s*(?:记住|记一下|记录)我的声音${TAIL}`);

export function detectEnrollIntent(text: string): EnrollIntent | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const named = NAMED_RE.exec(normalized);
  const name = named?.[1]?.trim();
  if (name && name !== '谁') return { kind: 'named', displayName: name };
  if (UNNAMED_RE.test(normalized)) return { kind: 'unnamed' };
  return null;
}

/**
 * awaiting_name 阶段的名字提取：上下文已明确（Javis 刚问"你叫什么名字"），宽松匹配。
 * 支持「我是川哥 / 我叫川哥 / 叫我川哥 / 川哥」；排除疑问与否定。
 * 裸名字（无"我叫"前缀）收紧：≤4 字 + 口头禅黑名单——"哈哈随便啦"这类闲聊不能当名字。
 */
const NAME_CHITCHAT = /随便|哈哈|呵呵|嘿嘿|没有|知道|你好|谢谢|再见|拜拜|等等|好的|好啊|好呀|可以|是的|什么|不|别/;

export function extractNameReply(text: string): string | null {
  const normalized = text
    .trim()
    .replace(/[。.!！?？~\s]+$/, '')
    .replace(/^[嗯啊哦呃唔]+[,，]?\s*/, '')
    .replace(/[啦咯哟哈呀吧呢嘛]+$/, '');
  if (!normalized || normalized.length > 24) return null;
  if (/谁|不知道|不告诉|为什么|干嘛|什么意思/.test(normalized)) return null;
  const m = /^(?:我是|我叫|叫我|就叫)\s*(?!不是|就是|也是)([一-龥A-Za-z0-9·]{1,8})$/.exec(normalized);
  if (m?.[1]) return m[1];
  // 裸名字（无"我叫"前缀）：中文 ≤4 字 / 英文 ≤12 字符，拒口头禅与含否定字的闲聊（"就不说"）
  const bare = /^[一-龥]{1,4}$|^[A-Za-z][A-Za-z0-9·]{0,11}$/.test(normalized);
  if (bare && !NAME_CHITCHAT.test(normalized)) return normalized;
  return null;
}

/** 建/更新注册会话（幂等：Prefill interim 先触发、final 再触发时以 final 的名字为准）。 */
export function startEnroll(roomId: string, displayName: string): EnrollSession {
  const now = Date.now();
  const session: EnrollSession = {
    roomId,
    displayName,
    state: 'recording',
    attempt: (getEnroll(roomId)?.attempt ?? 0) + 0, // attempt 只在失败重试时递增
    nameRetries: 0,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(roomId, session);
  return session;
}

/** 无名意图：先进 awaiting_name（Javis 反问名字），拿到名字后转 recording。 */
export function startEnrollAwaitingName(roomId: string): EnrollSession {
  const existing = getEnroll(roomId);
  if (existing?.state === 'awaiting_name') return existing; // Prefill interim 幂等
  const now = Date.now();
  const session: EnrollSession = {
    roomId,
    displayName: '',
    state: 'awaiting_name',
    attempt: 0,
    nameRetries: 0,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(roomId, session);
  return session;
}

/** awaiting_name 追问一次；超限返回 false（调用方 clear + 放弃话术）。 */
export function bumpNameRetry(roomId: string): boolean {
  const s = sessions.get(roomId);
  if (!s || s.state !== 'awaiting_name') return false;
  s.nameRetries += 1;
  return s.nameRetries <= 2;
}

/** 用户想中止注册流程（"算了/不弄了/取消"）。 */
export function isEnrollCancel(text: string): boolean {
  return /算了|不弄了|不用了|取消|先不|不记了/.test(text.trim());
}

/** 读会话（惰性过期清理）。 */
export function getEnroll(roomId: string | undefined): EnrollSession | undefined {
  if (!roomId) return undefined;
  const s = sessions.get(roomId);
  if (!s) return undefined;
  if (Date.now() > s.expiresAt) {
    sessions.delete(roomId);
    return undefined;
  }
  return s;
}

export function completeEnroll(roomId: string): void {
  const s = sessions.get(roomId);
  if (!s) return;
  s.state = 'done';
  s.expiresAt = Date.now() + 15_000; // done 状态留 15s 给前端轮询确认后消失
}

/** 失败：还有重试额度 → 回 recording 让前端重录；否则 failed。返回是否可重试。 */
export function failEnroll(roomId: string, error: string): boolean {
  const s = sessions.get(roomId);
  if (!s) return false;
  s.attempt += 1;
  s.lastError = error;
  if (s.attempt < MAX_ATTEMPTS) {
    s.state = 'recording';
    s.expiresAt = Date.now() + RETRY_TTL_MS;
    return true;
  }
  s.state = 'failed';
  s.expiresAt = Date.now() + 15_000;
  return false;
}

export function clearEnroll(roomId: string): void {
  sessions.delete(roomId);
}

// ---------- 话术（server 直出，不走 LLM，保证可控） ----------

/** 意图命中后的引导语：让用户自然连续说话 ≥15s（有效语音 ≥12s 是火山硬性要求）。 */
export function enrollGuideLine(displayName: string): string {
  return (
    `好呀${displayName}，我来记一下你的声音。接下来你随便跟我聊二十秒左右，` +
    `比如今天做了什么、最近喜欢什么，说得越自然越好，我安静听你说。`
  );
}

/** 无名意图：反问名字。 */
export function enrollAskNameLine(): string {
  return `好呀，我来记你的声音。先告诉我，怎么称呼你？`;
}

/** awaiting_name 阶段没听出名字：再问一次。 */
export function enrollNameRetryLine(): string {
  return `没听清名字，你就说"我叫某某"，或者直接说名字就行。`;
}

/** 已满 3 人的拒绝话术。 */
export function enrollFullLine(existingNames: string[]): string {
  return `我最多只能记住三个人的声音，现在已经记了${existingNames.join('、')}。想换人的话，要先让我忘掉一位哦。`;
}

/** 同名重注册的引导语。 */
export function enrollReplaceLine(displayName: string): string {
  return `${displayName}，你的声音我之前记过，这次就当重新记一遍。来，随便跟我聊二十秒左右，我认真听。`;
}

/** 录音期间的倾听哼声（轮换，短到不污染录音；AEC 已消回声，双保险）。 */
const LISTEN_ACKS = ['嗯嗯。', '嗯，你说。', '在听呢。', '嗯。', '继续继续。'];
let ackIdx = 0;
export function listeningAck(): string {
  const ack = LISTEN_ACKS[ackIdx % LISTEN_ACKS.length]!;
  ackIdx += 1;
  return ack;
}

// ---------- 注册结果播报（经 ExternalTextToSpeech 直接 TTS，见 routes/voiceprint.ts） ----------

export function enrollSuccessLine(displayName: string): string {
  return `好啦${displayName}，我记住你的声音了！下次通话我就能听出是你。`;
}

export function enrollRetryLine(): string {
  return `刚才好像没听够，你再多跟我说几句呗，自然聊就行。`;
}

export function enrollFailLine(): string {
  return `这次没记成，咱们下次再试吧。`;
}
