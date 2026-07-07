/**
 * R2 隐私 vault 两条链路（docs/memory-architecture.md §4.2/§4.3）：
 *
 * 1. usePrivacyVaultSync —— 拉/焚：轮询 /api/privacy/pending（15s + jv-sync privacy 域
 *    事件立即拉）→ 写本机 vault → ack（server 即焚）。落库成功才 ack，途中崩溃下轮重拉（幂等 upsert）。
 * 2. useSessionContextPush —— 通话注入：connected 时把 vault 记忆上行 server 内存
 *    （recall 同池打分），挂断/卸载 DELETE 清理。
 *
 * ⚠️ 轮询/watch effect 依赖最小化 + ref 桥接（react_effect_dep_churn 教训）。
 */
import { useEffect, useRef } from 'react';
import { apiFetch } from './api';
import { upsertVaultMemories, vaultItemsForSession } from './vault';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const VAULT_CHANGED_EVENT = 'jv-vault-changed';

async function pullOnce(): Promise<void> {
  const res = await apiFetch('/api/privacy/pending');
  const data = (await res.json()) as {
    ok: boolean;
    items?: Array<{
      memory: {
        id: string;
        ownerId: string;
        type: string;
        content: { key: string; value: string };
        sourceSpan?: string;
        status: string;
        confidence: number;
        createdAt: number;
      };
      heldAt: number;
      classify?: { reason?: string; hit?: string };
    }>;
  };
  if (!data.ok || !data.items?.length) return;
  const stored = await upsertVaultMemories(data.items);
  if (stored === 0) return; // 非 Tauri 环境（vault 不可用）：不 ack，不焚——宁留 server 勿丢
  const ids = data.items.map((entry) => entry.memory.id);
  await apiFetch('/api/privacy/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  console.log(`[vault] pulled+burned ${ids.length} private memories`);
  window.dispatchEvent(new CustomEvent(VAULT_CHANGED_EVENT));
}

export function usePrivacyVaultSync(): void {
  useEffect(() => {
    if (!isTauri()) return; // 浏览器 dev：无本机 vault，不拉取（否则拉了存不下）
    let stopped = false;
    const tick = () => {
      if (!stopped) pullOnce().catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    const onSync = (event: Event) => {
      if ((event as CustomEvent<{ domain?: string }>).detail?.domain === 'privacy') tick();
    };
    window.addEventListener('jv-sync', onSync);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('jv-sync', onSync);
    };
  }, []);
}

/** 通话开始上行 vault 记忆 → server 内存；挂断/卸载清理。 */
export function useSessionContextPush(connected: boolean, roomId: string | null): void {
  const lastPushedRoom = useRef<string | null>(null);

  useEffect(() => {
    if (connected && roomId && lastPushedRoom.current !== roomId) {
      lastPushedRoom.current = roomId;
      void (async () => {
        try {
          const items = await vaultItemsForSession();
          if (items.length === 0) return;
          await apiFetch('/api/privacy/session-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, items }),
          });
          console.log(`[vault] session-context pushed: ${items.length} items → room ${roomId}`);
        } catch {
          /* 上行失败：本轮通话隐私记忆不可用，不阻塞通话 */
        }
      })();
    }
    if (!connected && lastPushedRoom.current) {
      const room = lastPushedRoom.current;
      lastPushedRoom.current = null;
      apiFetch(`/api/privacy/session-context/${encodeURIComponent(room)}`, { method: 'DELETE' }).catch(() => {});
    }
  }, [connected, roomId]);

  // 页面卸载兜底清理（server 侧另有 2h TTL 双保险）
  useEffect(() => {
    const onUnload = () => {
      const room = lastPushedRoom.current;
      if (room) {
        apiFetch(`/api/privacy/session-context/${encodeURIComponent(room)}`, { method: 'DELETE' }).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
}
