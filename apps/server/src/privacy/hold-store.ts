/**
 * 隐私记忆内存 hold 队列（R2，docs/memory-architecture.md §4.2）。
 *
 * 语义：remember 判定隐私 → 不落云端盘 → 在此内存暂存 → App 在线时拉走（pending）
 * → 确认落本机 vault 后 ack 即焚。server 重启丢失队列 = 宁丢勿泄（by design）；
 * 丢失窗口由 App tray 常驻压缩。
 *
 * 红线：本模块之外不得持有 item 引用；日志/审计一律只记条数与 id，绝不记内容。
 */
import { bumpSyncVersion } from '../sync/versions.js';
import type { MemoryItem } from '../memory/types.js';
import type { PrivacyClassifyResult } from '../memory-core/privacy.js';

export interface PrivacyPendingItem {
  item: MemoryItem;
  heldAt: number;
  classify: PrivacyClassifyResult;
}

/** 每租户上限：超出丢最旧（宁丢勿泄 + 防内存膨胀），丢弃计数进审计。 */
const PER_TENANT_CAP = 200;

const queues = new Map<string, PrivacyPendingItem[]>();

export function holdPrivacyItem(tenantId: string, item: MemoryItem, classify: PrivacyClassifyResult): { dropped: number } {
  const queue = queues.get(tenantId) ?? [];
  queue.push({ item, heldAt: Date.now(), classify });
  let dropped = 0;
  while (queue.length > PER_TENANT_CAP) {
    queue.shift();
    dropped += 1;
  }
  queues.set(tenantId, queue);
  bumpSyncVersion(tenantId, 'privacy');
  return { dropped };
}

/** 拉取不删除（拉取与确认分离，App 落库成功才 ack——防拉取途中崩溃丢数据）。 */
export function listPendingPrivacy(tenantId: string): PrivacyPendingItem[] {
  return [...(queues.get(tenantId) ?? [])];
}

/** ack 即焚：从队列移除指定 id，返回实际焚毁条数。 */
export function ackPrivacyItems(tenantId: string, ids: string[]): number {
  const queue = queues.get(tenantId);
  if (!queue || ids.length === 0) return 0;
  const idSet = new Set(ids);
  const before = queue.length;
  const remaining = queue.filter((entry) => !idSet.has(entry.item.id));
  queues.set(tenantId, remaining);
  const burned = before - remaining.length;
  if (burned > 0) bumpSyncVersion(tenantId, 'privacy');
  return burned;
}

export function pendingCount(tenantId: string): number {
  return queues.get(tenantId)?.length ?? 0;
}

/** 测试专用：清空全部队列。 */
export function _resetPrivacyHold(): void {
  queues.clear();
}
