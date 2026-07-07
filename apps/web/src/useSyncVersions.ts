/**
 * UI 同步（川哥原则：一切操作/状态变化，展示该数据的面板必须同步更新——
 * 语音"忘掉X的声音"删了 server 数据，面板不能还显示旧的）。
 *
 * 机制：5s 轮询 /api/sync/versions（server 纯内存，零 DB 查询），某域版本变化就
 * `window.dispatchEvent(new CustomEvent('jv-sync', { detail: { domain } }))`；
 * 面板用 useSyncRefresh(domain, load) 订阅，任何写入路径（语音/面板/调度器/多端）都被动同步。
 * 轮询 effect 依赖空数组（react_effect_dep_churn 教训）。
 */
import { useEffect, useRef } from 'react';
import { apiFetch } from './api';

export type SyncDomain = 'voiceprint' | 'reminder' | 'privacy';

const POLL_MS = 5_000;

/** App 根组件调用一次：版本轮询 + 变化广播。 */
export function useSyncVersions(): void {
  useEffect(() => {
    let last: Partial<Record<SyncDomain, string>> = {};
    const tick = async (): Promise<void> => {
      try {
        const res = await apiFetch('/api/sync/versions');
        if (!res.ok) return;
        const data = (await res.json()) as { ok: boolean; versions?: Record<SyncDomain, string> };
        if (!data.versions) return;
        for (const domain of Object.keys(data.versions) as SyncDomain[]) {
          const v = data.versions[domain];
          if (last[domain] !== undefined && last[domain] !== v) {
            window.dispatchEvent(new CustomEvent('jv-sync', { detail: { domain } }));
          }
          last[domain] = v;
        }
      } catch {
        /* 网络抖动：下轮再试 */
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => clearInterval(timer);
  }, []);
}

/** 面板订阅：自己域的数据变了就 reload（reload 经 ref 桥接，监听器不随渲染拆建）。 */
export function useSyncRefresh(domain: SyncDomain, reload: () => void): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const handler = (e: Event): void => {
      if ((e as CustomEvent<{ domain: SyncDomain }>).detail?.domain === domain) reloadRef.current();
    };
    window.addEventListener('jv-sync', handler);
    return () => window.removeEventListener('jv-sync', handler);
  }, [domain]);
}
