/**
 * 贾维斯唤醒词（Rust 侧 KWS）的前端桥。
 *
 * - 仅在 Tauri 环境生效（桌面 App）；浏览器/preview 里全部优雅降级为 no-op
 *   （dev 网页照常跑，唤醒只能点球 PTT——KWS 是桌面壳的原生能力）。
 * - Tauri API 动态 import：避免 vite 在纯 web 构建时把依赖打进首屏。
 */

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function kwsStart(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('kws_start');
    console.log('[kws] start requested');
  } catch (e) {
    console.log('[kws] start failed:', (e as Error)?.message ?? e);
  }
}

export async function kwsStop(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('kws_stop');
  } catch (e) {
    console.log('[kws] stop failed:', (e as Error)?.message ?? e);
  }
}

/** 订阅唤醒事件。返回取消函数（非 Tauri 环境返回 null）。 */
export async function onKwsWake(cb: (keyword: string) => void): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<{ keyword: string }>('kws-wake', (event) => {
      cb(event.payload?.keyword ?? '');
    });
    return unlisten;
  } catch (e) {
    console.log('[kws] listen failed:', (e as Error)?.message ?? e);
    return null;
  }
}
