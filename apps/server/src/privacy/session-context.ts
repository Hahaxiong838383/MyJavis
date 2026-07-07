/**
 * 通话级隐私上下文（R2，docs/memory-architecture.md §4.3）。
 *
 * App 在通话开始时把本机 vault 记忆上行到这里（server 内存），recall 时按 owner
 * 过滤后并进候选统一打分——**分人记忆红线**：声纹 A 的隐私绝不注入声纹 B 的对话。
 * 生命周期：房间显式清理（App 挂断）或 TTL 兜底过期；server 全程零落盘，
 * 日志/审计只记条数。
 */

export interface SessionPrivacyItem {
  id: string;
  ownerId: string;
  text: string;
  type: string;
  createdAt: number;
}

interface RoomContext {
  tenantId: string;
  items: SessionPrivacyItem[];
  expiresAt: number;
}

/** 单房间上限（内测隐私记忆量级几十条，100 足够；超出取最新）。 */
const PER_ROOM_CAP = 100;
/** TTL 兜底：App 崩溃没发显式清理时，2h 后自动弃。 */
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

const rooms = new Map<string, RoomContext>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [roomId, ctx] of rooms) {
    if (ctx.expiresAt <= now) rooms.delete(roomId);
  }
}

/** 整房间替换语义（App 每次通话开始推全量），返回实际接受条数。 */
export function setSessionContext(tenantId: string, roomId: string, items: SessionPrivacyItem[]): number {
  sweepExpired();
  const accepted = [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, PER_ROOM_CAP);
  rooms.set(roomId, { tenantId, items: accepted, expiresAt: Date.now() + ROOM_TTL_MS });
  return accepted.length;
}

/** recall 侧读取：按 owner 过滤（分人红线），返回副本。 */
export function getSessionContextForOwner(roomId: string | undefined, ownerId: string): SessionPrivacyItem[] {
  if (!roomId) return [];
  sweepExpired();
  const ctx = rooms.get(roomId);
  if (!ctx) return [];
  return ctx.items.filter((item) => item.ownerId === ownerId);
}

export function clearSessionContext(tenantId: string, roomId: string): boolean {
  const ctx = rooms.get(roomId);
  if (!ctx || ctx.tenantId !== tenantId) return false;
  rooms.delete(roomId);
  return true;
}

/** 测试专用。 */
export function _resetSessionContext(): void {
  rooms.clear();
}
