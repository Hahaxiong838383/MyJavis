/**
 * R4 提炼代理消费方（docs/memory-architecture.md §4.4）。
 *
 * 1. scheduleRefine()：通话挂断时调用（见 useVoiceRtc.stop()），invoke Rust `refine_schedule`——
 *    Rust 侧独立线程计时 5 分钟静默，规避 WKWebView 隐藏时 JS 定时器被节流。
 * 2. useMemoryRefineConsumer()：监听 Rust emit 的 `refine-due` 事件 → 取本机 vault 待提炼批次
 *    → POST /api/memory/refine → 按决策写回 vault。
 *
 * 降级契约：非 Tauri 环境 / server 端点关闭(503) / 网络失败 / LLM 失败(502) → 批次原样保留
 * （vault 行 refined_at 不置位），下一次 refine-due（下一通电话结束）自然重试——不丢数据，
 * 纯静默降级；server 开关独立于 App 侧，App 不需要自己的 localStorage 开关（doc §C.3）。
 */
import { useEffect } from 'react';
import { apiFetch } from './api';
import { applyRefineDecisions, loadRefineBatch, type RefineDecision } from './vault';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 通话结束时调用：请求/重置 Rust 侧 5 分钟静默计时器。非 Tauri 环境 no-op。 */
export function scheduleRefine(): void {
  if (!isTauri()) return;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('refine_schedule'))
    .catch((e) => console.log('[refine] schedule failed:', (e as Error)?.message ?? e));
}

async function runRefineOnce(): Promise<void> {
  const batch = await loadRefineBatch();
  if (batch.pendingIds.size === 0) return; // 无待提炼条目：不发请求
  try {
    const res = await apiFetch('/api/memory/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: batch.items }),
    });
    if (!res.ok) {
      console.log(`[refine] server declined status=${res.status}（批次保留，下轮重试）`);
      return;
    }
    const data = (await res.json()) as { ok: boolean; decisions?: RefineDecision[] };
    if (!data.ok || !data.decisions) return;
    const applied = await applyRefineDecisions(batch, data.decisions);
    console.log(`[refine] applied ${applied}/${batch.pendingIds.size} decisions`);
  } catch (e) {
    console.log('[refine] request failed, batch kept for retry:', (e as Error)?.message ?? e);
  }
}

/** 订阅 refine-due 事件，触发一轮提炼。非 Tauri 环境 no-op。 */
export function useMemoryRefineConsumer(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('refine-due', () => void runRefineOnce()))
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((e) => console.log('[refine] listen failed:', (e as Error)?.message ?? e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
