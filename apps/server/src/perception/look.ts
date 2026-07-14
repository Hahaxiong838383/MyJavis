/**
 * 切片3：look_closely 按需细看（2026-07-14 川哥拍板）——本地符号层答不了的开放视觉问题，
 * 用户主动问 → 主 LLM 调工具 → 两段式回答：
 *   第一段：LLM 当轮 ack（"我仔细看看啊…"）；
 *   第二段：探针轮询取走请求 → 抓一帧直调云 VLM（帧 Mac→火山，不经本 server）→
 *           semantic 上报 → 本模块插播描述到房间。
 * 隐私定位：仅用户明确发问时单帧上云（知情+低频）；server 只见描述文本，零帧零落盘。
 * 超时兜底（TTL 15s）：插播"刚才没看太清"，绝不让"我看看"悬空。
 */
import { config } from '../config.js';
import { speakText } from '../providers/rtc-control.js';

const LOOK_TTL_MS = 15_000;

interface LookDeps {
  speak: (roomId: string, text: string, interrupt?: boolean) => Promise<void>;
}

interface LookRequest {
  question: string;
  roomId: string;
  requestedAt: number;
  taken: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, LookRequest>();

export function _resetLookState(): void {
  for (const r of pending.values()) clearTimeout(r.timer);
  pending.clear();
}

/** onToolCall 调用：登记细看请求（同租户并发只保留最新一个）。 */
export function requestLook(
  tenantId: string,
  roomId: string,
  question: string,
  deps: LookDeps = { speak: speakText },
): void {
  const prev = pending.get(tenantId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    const cur = pending.get(tenantId);
    if (!cur) return;
    pending.delete(tenantId);
    console.log(`[look] timeout tenant=${tenantId.slice(0, 8)} q="${cur.question.slice(0, 20)}"`);
    deps.speak(cur.roomId, '唔，刚才没看太清，要不你再问我一次？', false).catch(() => {});
  }, LOOK_TTL_MS);
  timer.unref?.();
  pending.set(tenantId, { question, roomId, requestedAt: Date.now(), taken: false, timer });
  console.log(`[look] requested tenant=${tenantId.slice(0, 8)} q="${question.slice(0, 30)}"`);
}

/** 探针轮询取请求（取走后仍等 completeLook，TTL 计时不变）。 */
export function takeLookRequest(tenantId: string): { question: string } | null {
  const r = pending.get(tenantId);
  if (!r || r.taken) return null;
  r.taken = true;
  return { question: r.question };
}

/** 探针 semantic 上报到达：插播描述（第二段回答）。返回是否消费了一个在途请求。 */
export async function completeLook(
  tenantId: string,
  description: string,
  deps: LookDeps = { speak: speakText },
): Promise<boolean> {
  const r = pending.get(tenantId);
  if (!r) return false;
  clearTimeout(r.timer);
  pending.delete(tenantId);
  const text = description.trim();
  const line = text ? `看清了——${text}` : '唔，刚才没看太清，要不你再问我一次？';
  try {
    await deps.speak(r.roomId, line, false);
  } catch (err) {
    console.log(`[look] speak failed tenant=${tenantId.slice(0, 8)}: ${(err as Error).message.slice(0, 60)}`);
    return true;
  }
  console.log(`[look] completed tenant=${tenantId.slice(0, 8)} elapsed=${Date.now() - r.requestedAt}ms`);
  return true;
}

export function lookEnabled(): boolean {
  return config.vision.enabled && config.vision.lookEnabled;
}
