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

export type EnrollState = 'awaiting_name' | 'confirming_name' | 'recording' | 'done' | 'failed';

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

export interface NameReply {
  name: string;
  /** 裸名字（无"我叫"前缀）——误把闲聊当名字的高危形态（真机"唱歌"事故），须复述确认。 */
  bare: boolean;
}

export function extractNameReplyDetailed(text: string): NameReply | null {
  const normalized = text
    .trim()
    .replace(/[。.!！?？~\s]+$/, '')
    .replace(/^[嗯啊哦呃唔]+[,，]?\s*/, '')
    .replace(/[啦咯哟哈呀吧呢嘛]+$/, '');
  if (!normalized || normalized.length > 24) return null;
  if (/谁|不知道|不告诉|为什么|干嘛|什么意思/.test(normalized)) return null;
  const m = /^(?:我是|我叫|叫我|就叫)\s*(?!不是|就是|也是)([一-龥A-Za-z0-9·]{1,8})$/.exec(normalized);
  if (m?.[1]) return { name: m[1], bare: false };
  // 裸名字（无"我叫"前缀）：中文 ≤4 字 / 英文 ≤12 字符，拒口头禅与含否定字的闲聊（"就不说"）
  const bare = /^[一-龥]{1,4}$|^[A-Za-z][A-Za-z0-9·]{0,11}$/.test(normalized);
  if (bare && !NAME_CHITCHAT.test(normalized)) return { name: normalized, bare: true };
  return null;
}

/** 兼容旧签名（既有测试/调用方）。 */
export function extractNameReply(text: string): string | null {
  return extractNameReplyDetailed(text)?.name ?? null;
}

/** confirming 场景通用的确认/否认（宁漏勿误：不确定就当没回答，交调用方重试/放行）。 */
export function isConfirmYes(text: string): boolean {
  const t = text.trim().replace(/[。.!！~啊呀呢嘛哦哇吧的\s]+$/, '');
  return /^(?:对|对对|是|是滴|没错|嗯|嗯嗯|好|确定|正确|可以|要得|删|删掉|忘|忘掉)$/.test(t);
}
export function isConfirmNo(text: string): boolean {
  const t = text.trim();
  return /^(?:不对|不是|错了|不|没有|别|不叫这个|等等)/.test(t);
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

/**
 * S1 名字确认（2026-07-07，真机"唱歌"误注册教训）：awaiting_name 阶段听到的**裸名字**
 * （无"我叫"前缀）先复述确认再开录——闲聊词被当名字会白占 3 人名额。
 * displayName 暂存待确认名；确认后调用方走 startEnroll 转 recording。
 */
export function startEnrollConfirmingName(roomId: string, pendingName: string): EnrollSession {
  const now = Date.now();
  const session: EnrollSession = {
    roomId,
    displayName: pendingName,
    state: 'confirming_name',
    attempt: 0,
    nameRetries: getEnroll(roomId)?.nameRetries ?? 0,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(roomId, session);
  return session;
}

/** confirming_name 否认 → 回 awaiting_name 重问（沿用重试计数，防无限循环）。 */
export function backToAwaitingName(roomId: string): void {
  const s = sessions.get(roomId);
  if (!s) return;
  s.state = 'awaiting_name';
  s.displayName = '';
  s.expiresAt = Date.now() + SESSION_TTL_MS;
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

// ---------- 注册即生效（称呼层桥接，2026-07-08 生产实测驱动） ----------
// 火山 IdList 仅 StartVoiceChat 时传入（S6 硬限）：刚注册的声纹本房间不会打标签。
// 不桥接的话，用户刚听完"我记住你的声音了"下一句又被叫回默认称呼（川哥实测"还叫臭臭"）。
// 房间余下时间内无标签发言按刚注册的名字称呼；真声纹标签出现则让位（taggedName 优先级更高）。
// 仅称呼层——不碰身份证据链 / 记忆归属（identityResolution 保持纯净）。

const freshEnrollNames = new Map<string, string>(); // roomId → 刚注册的 displayName

export function setFreshEnrollName(roomId: string, displayName: string): void {
  freshEnrollNames.set(roomId, displayName);
}

export function getFreshEnrollName(roomId: string | undefined): string | undefined {
  return roomId ? freshEnrollNames.get(roomId) : undefined;
}

/** 房间关闭（手动 stop / 僵尸清扫 / 踢旧）时清理，防 Map 无界增长。 */
export function clearFreshEnrollName(roomId: string): void {
  freshEnrollNames.delete(roomId);
}

// ---------- 话术（server 直出，不走 LLM，保证可控） ----------

/**
 * 意图命中后的引导语：让用户自然连续说话 ≥15s（有效语音 ≥12s 是火山硬性要求）。
 * 质量提示（2026-07-03 真机教训：川哥样本 28.2s 强停=断续弱样本 → 声纹 0 次匹配）：
 * 离麦近 + 连续说，是样本质量的两个最大变量。
 */
export function enrollGuideLine(displayName: string): string {
  return (
    `好呀${displayName}，我来记一下你的声音。你离我近一点，用平时说话的音量，` +
    `连续地跟我聊二十秒，比如今天做了什么、最近喜欢什么，中间别停太久，我安静听你说。`
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

/** 已满 3 人的拒绝话术（S3：给出可执行的语音路径，与"忘掉X的声音"意图联动）。 */
export function enrollFullLine(existingNames: string[]): string {
  return (
    `我最多只能记住三个人的声音，现在已经记了${existingNames.join('、')}。` +
    `想换人的话，先说"忘掉某某的声音"，我腾出位置再记你。`
  );
}

/** S1 裸名字复述确认话术。 */
export function enrollConfirmNameLine(pendingName: string): string {
  return `我听到的名字是「${pendingName}」，对吗？对的话我就开始记你的声音。`;
}

/** 同名重注册的引导语。 */
export function enrollReplaceLine(displayName: string): string {
  return `${displayName}，你的声音我之前记过，这次就当重新记一遍。来，随便跟我聊二十秒左右，我认真听。`;
}

/**
 * 录音期间 Javis 完全静默（返回空格 = 无 TTS）。
 * 曾用轮换哼声（嗯嗯/在听呢）防冷场，真机发现哼声外放会混进声纹样本（AEC 残留）拉低质量；
 * 引导语已承诺"我安静听你说"，视觉反馈由 App 进度条承担。
 */
export function listeningAck(): string {
  return ' ';
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
