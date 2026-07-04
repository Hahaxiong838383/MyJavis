/**
 * 音乐待执行指令存储（模仿 enroll-session.ts 的会话态管理）。
 *
 * 语义：setPending 后，前端轮询 /api/music/pending 取走即清空（takePending）。
 * 内存存储，单进程重启丢失可接受（用户再说一遍指令）。
 */

export type PendingMusicCommand =
  | { action: 'play'; streamUrl: string; title: string }
  | { action: 'control'; control: string };

const pending = new Map<string, PendingMusicCommand | undefined>();

export function setPending(roomId: string, cmd: PendingMusicCommand): void {
  if (!roomId) return;
  pending.set(roomId, cmd);
}

export function takePending(roomId: string | undefined): PendingMusicCommand | null {
  if (!roomId) return null;
  const cmd = pending.get(roomId);
  if (cmd) {
    pending.delete(roomId);
    return cmd;
  }
  return null;
}

export function clearPending(roomId: string): void {
  pending.delete(roomId);
}
