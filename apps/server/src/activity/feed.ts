/**
 * 记忆系统活动流（R3，川哥点名：运行机制和状态要在 App 界面真实实时显示）。
 *
 * per-tenant 内存环形缓冲（最近 50 条）：召回/写入/隐私转移/事实失效/批处理精修
 * 全类型事件。持久审计在 audit 表（治理面板可查），这里专供实时展示——
 * 每次 push 都 bump sync 'memory' 域，面板 ≤5s 自动刷新（UI 同步原则）。
 *
 * 红线：summary 由事件生产方生成，隐私类事件只带条数绝不带内容。
 */
import { bumpSyncVersion } from '../sync/versions.js';

export type ActivityKind = 'recall' | 'write' | 'privacy_route' | 'invalidate' | 'refine' | 'correction';

export interface ActivityEvent {
  ts: number;
  kind: ActivityKind;
  /** 人话摘要（面板直显），隐私事件零内容。 */
  summary: string;
  /** 可选结构化细节（面板展开用；同样遵守隐私红线）。 */
  detail?: Record<string, unknown>;
}

const CAP = 50;
const feeds = new Map<string, ActivityEvent[]>();

export function pushActivity(tenantId: string | undefined | null, event: Omit<ActivityEvent, 'ts'>): void {
  if (!tenantId) return;
  const feed = feeds.get(tenantId) ?? [];
  feed.push({ ...event, ts: Date.now() });
  while (feed.length > CAP) feed.shift();
  feeds.set(tenantId, feed);
  bumpSyncVersion(tenantId, 'memory');
}

/** 最新在前。 */
export function listActivity(tenantId: string, limit = 50): ActivityEvent[] {
  return [...(feeds.get(tenantId) ?? [])].reverse().slice(0, limit);
}

/** 测试专用。 */
export function _resetActivity(): void {
  feeds.clear();
}
