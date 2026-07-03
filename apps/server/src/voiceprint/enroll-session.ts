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

export type EnrollState = 'recording' | 'done' | 'failed';

export interface EnrollSession {
  roomId: string;
  displayName: string;
  state: EnrollState;
  attempt: number; // 录音上传尝试次数（火山拒后可重试，≤MAX_ATTEMPTS）
  createdAt: number;
  expiresAt: number;
  lastError?: string;
}

const SESSION_TTL_MS = 120_000; // 引导+录音+上传全程窗口；超时自动作废（用户再说一遍）
const RETRY_TTL_MS = 90_000; // 失败重录窗口
export const MAX_ATTEMPTS = 2;

const sessions = new Map<string, EnrollSession>();

/**
 * 意图识别：「我是X，记住我」类。三重防误触发（宁漏勿误——漏了用户重说一遍，误触发很尴尬）：
 * ① 名字位排除"不是/就是/也是"开头；② "记住我"后不能接"的"（防"记住我的日程"）；
 * ③ 意图短语后必须句末或语气词收尾（防"…记住我干嘛/…记住我日程的那个人"）。
 */
export function detectEnrollIntent(text: string): { displayName: string } | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const m =
    /(?:我是|我叫)\s*(?!不是|就是|也是)([一-龥A-Za-z0-9·]{1,8}?)\s*[,，。!！]?\s*(?:记住我的声音|请?(?:记住|记一下|记录|认识)(?:一下)?我(?!的))[吧呀啊哦呢哈哟~！!。.，,\s]*$/.exec(
      normalized,
    );
  const name = m?.[1]?.trim();
  if (!name || name === '谁') return null;
  return { displayName: name };
}

/** 建/更新注册会话（幂等：Prefill interim 先触发、final 再触发时以 final 的名字为准）。 */
export function startEnroll(roomId: string, displayName: string): EnrollSession {
  const now = Date.now();
  const session: EnrollSession = {
    roomId,
    displayName,
    state: 'recording',
    attempt: (getEnroll(roomId)?.attempt ?? 0) + 0, // attempt 只在失败重试时递增
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(roomId, session);
  return session;
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
