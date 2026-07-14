/**
 * Vision 探针桥（0.17.2 起 App 常开，2026-07-14 川哥拍板）：
 *
 * - App 启动（App.tsx mount）→ startVisionProbe()：探针随 App 常开（绿灯 App 期间常亮），
 *   非通话时段感知照常积累（reminder 触达判定/开场上下文）。
 * - 通话开始再调一次 = 幂等兜底（探针意外挂了自动重拉）。
 * - 停止：App 退出（Rust 兜底 kill）或设置面板开关关闭；挂断不再停。
 * - 预检 vision_available：未装探针的机器不弹摄像头授权，全静默 no-op。
 *
 * 开关：localStorage jv_vision_enabled（'0'=关；默认开）。
 */
import { API_BASE, currentApiKey } from './api.js';

const VISION_TOGGLE_KEY = 'jv_vision_enabled';

const isTauri = (): boolean =>
  typeof window !== 'undefined' && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export function visionEnabled(): boolean {
  try {
    return localStorage.getItem(VISION_TOGGLE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setVisionEnabled(on: boolean): void {
  try {
    localStorage.setItem(VISION_TOGGLE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export async function startVisionProbe(): Promise<void> {
  if (!isTauri() || !visionEnabled()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // 预检：探针未安装（内测用户机器）直接静默——不弹摄像头授权不留悬念
    if (!(await invoke('vision_available'))) return;
  } catch {
    return;
  }
  try {
    // 确权（真机实证 2026-07-14 两轮迭代）：TCC 对 spawn 子进程静默拒绝，须由 WebView
    // 以 App 名义确权。但 getUserMedia 会让页面进入 capture 态——WKWebView 对 capture 页
    // 的音频输出有压制且疑似 stop 后不回退（"每次启动都轻"排障主嫌疑）。因此：
    //  - 已授权（granted）：完全不碰 getUserMedia，零 capture 直接 spawn（常态路径）；
    //  - 未授权（prompt）：才走一次 getUserMedia 弹授权，拿到立即关流；
    //  - 拒绝（denied）：静默不拉探针。
    const perm = await navigator.permissions.query({ name: 'camera' as PermissionName });
    if (perm.state === 'denied') return;
    if (perm.state !== 'granted') {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {
    // permissions API 不可用等异常：保守退回 getUserMedia 确权一次
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (e2) {
      console.log('[vision] camera permission unavailable:', (e2 as Error)?.name ?? e2);
      return;
    }
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('vision_start', {
      key: currentApiKey(),
      // Tauri 生产 build VITE_API_BASE=公网 server；空（dev 同源代理）时回退本地 server 直连
      server: API_BASE || 'http://127.0.0.1:3001',
    });
    console.log('[vision] probe start requested');
  } catch (e) {
    // probe-not-installed / no-key / spawn 失败：静默降级（server 无心跳=零注入，Javis 如实说看不到）
    console.log('[vision] probe unavailable:', (e as Error)?.message ?? e);
  }
}

export async function stopVisionProbe(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('vision_stop');
  } catch {
    /* ignore */
  }
}

/** 探针进程是否存活（设置面板状态显示用）。 */
export async function visionProbeRunning(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return Boolean(await invoke('vision_status'));
  } catch {
    return false;
  }
}
