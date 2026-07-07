/**
 * UI 同步版本号（川哥原则：一切操作/状态变化，展示该数据的 UI 面板必须同步更新——
 * 语音删声纹后面板仍显示旧数据的 bug 即此机制的由来，2026-07-07）。
 *
 * 机制：每租户每域一个内存版本 `bootEpoch:counter`；数据写入点（registry/store 内部）bump；
 * 前端统一 5s 轮询 GET /api/sync/versions（纯内存零查询），diff 到变化广播 CustomEvent，
 * 面板按域订阅刷新。任何写入路径（语音意图/REST/调度器/多端）都被动覆盖。
 * bootEpoch：server 重启 counter 归零，换 epoch 保证前端字符串比较必然"变化"，不漏刷。
 */

export type SyncDomain = 'voiceprint' | 'reminder' | 'privacy';

const DOMAINS: SyncDomain[] = ['voiceprint', 'reminder', 'privacy'];

const bootEpoch = Date.now().toString(36);
const counters = new Map<string, number>(); // `${tenantId}:${domain}` → counter

export function bumpSyncVersion(tenantId: string | undefined | null, domain: SyncDomain): void {
  if (!tenantId) return;
  const key = `${tenantId}:${domain}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function getSyncVersions(tenantId: string): Record<SyncDomain, string> {
  return Object.fromEntries(
    DOMAINS.map((domain) => [domain, `${bootEpoch}:${counters.get(`${tenantId}:${domain}`) ?? 0}`]),
  ) as Record<SyncDomain, string>;
}
