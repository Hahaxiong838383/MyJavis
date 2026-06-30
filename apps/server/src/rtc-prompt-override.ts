/**
 * 会话级 prompt override（抽取自 P003 rtc-prompt-override.ts）。
 *
 * 火山 RTC 进房后 StartVoiceChat 的 SystemMessages 不可中途改 → 把 prompt 存我方内存，
 * custom-llm 每轮回调按 roomId 取最新。用于「调试台/实时调 prompt」场景：
 * 改了 prompt 不重连，下一轮回调即用新值。
 *
 * 内存 Map + TTL（默认 2h）；roomId 即 session 键。无 override → custom-llm 走默认人设组装。
 */

interface OverrideEntry {
  prompt: string;
  expireTs: number;
}

const store = new Map<string, OverrideEntry>();
const TTL_MS = 2 * 60 * 60 * 1000; // 2h

export function setPromptOverride(roomId: string, prompt: string): void {
  if (!roomId || !prompt.trim()) return;
  store.set(roomId, { prompt, expireTs: Date.now() + TTL_MS });
}

export function getPromptOverride(roomId: string | undefined | null): string | null {
  if (!roomId) return null;
  const entry = store.get(roomId);
  if (!entry) return null;
  if (Date.now() > entry.expireTs) {
    store.delete(roomId);
    return null;
  }
  return entry.prompt;
}

export function clearPromptOverride(roomId: string): void {
  store.delete(roomId);
}
