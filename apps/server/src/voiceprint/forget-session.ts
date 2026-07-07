/**
 * S2 语音删除声纹：「忘掉X的声音」→ 二次确认 →（火山+本地）删除 → 播报。
 * 此前只能面板/DELETE API 手动删；满员话术引导"先让我忘掉一位"现在有语音闭环了（S3 联动）。
 *
 * 宁漏勿误：意图锚定「…的声音/声纹」结尾语义；删除是不可逆动作，必须二次确认。
 * 「忘掉我的声音」：有声纹标签/粘滞称呼时=当前说话人；认不出则请用户指名。
 */

export interface ForgetIntent {
  /** 目标显示名；'SELF' = "我的声音"（由调用方用当前说话人解析）。 */
  target: string;
}

const FORGET_RE =
  /(?:忘掉|忘记|删掉|删除|抹掉|去掉|别记)\s*([一-龥A-Za-z0-9·]{1,8}?|我)\s*的\s*(?:声音|声纹)[吧呀啊哦呢嘛！!。.，,?？\s]*$/;

export function detectForgetIntent(text: string): ForgetIntent | null {
  const m = FORGET_RE.exec(text.trim());
  if (!m?.[1]) return null;
  const raw = m[1];
  return { target: raw === '我' ? 'SELF' : raw };
}

interface PendingForget {
  roomId: string;
  voiceprintId: string;
  displayName: string;
  expiresAt: number;
}

const TTL_MS = 45_000;
const pending = new Map<string, PendingForget>();

export function startForgetConfirm(roomId: string, voiceprintId: string, displayName: string): void {
  pending.set(roomId, { roomId, voiceprintId, displayName, expiresAt: Date.now() + TTL_MS });
}

export function getForgetConfirm(roomId: string | undefined): PendingForget | undefined {
  if (!roomId) return undefined;
  const p = pending.get(roomId);
  if (!p) return undefined;
  if (Date.now() > p.expiresAt) {
    pending.delete(roomId);
    return undefined;
  }
  return p;
}

export function clearForgetConfirm(roomId: string): void {
  pending.delete(roomId);
}

// ---------- 话术 ----------

export function forgetConfirmLine(displayName: string): string {
  return `确定要我忘掉「${displayName}」的声音吗？忘掉之后就认不出 TA 了。`;
}
export function forgetDoneLine(displayName: string): string {
  return `好，我已经忘掉${displayName}的声音了。想再记的话随时说"我是${displayName}，记住我的声音"。`;
}
export function forgetNotFoundLine(target: string, existingNames: string[]): string {
  return existingNames.length
    ? `我没有记过${target}的声音哦，现在记着的是${existingNames.join('、')}。`
    : `我现在谁的声音都没记过呢。`;
}
export function forgetSelfUnknownLine(existingNames: string[]): string {
  return existingNames.length
    ? `我暂时没听出你是谁，你说"忘掉某某的声音"指下名字就行，现在记着的是${existingNames.join('、')}。`
    : `我现在谁的声音都没记过呢。`;
}
export function forgetAbortLine(): string {
  return '好，那就还记着。';
}
export function forgetFailLine(): string {
  return '刚才没删成，稍后再试一次吧。';
}
