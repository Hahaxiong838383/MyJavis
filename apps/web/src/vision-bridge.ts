/**
 * Vision 探针桥（0.16.0）：通话生命周期绑定的摄像头感知进程。
 *
 * - 进房成功 → startVisionProbe()：Tauri 拉起本机探针（摄像头绿灯只在通话中亮）。
 * - 挂断 → stopVisionProbe()。
 * - 浏览器环境 / 开关关 / 探针未安装（其他用户机器）→ 全部静默 no-op，通话零影响。
 *
 * 开关：localStorage jv_vision_enabled（'0'=关；默认开——未装探针的机器本来就无行为）。
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
    // 确权前置（真机实证 2026-07-14）：TCC 对 spawn 的子进程静默拒绝且不弹窗（子进程无
    // GUI 上下文）。WebView getUserMedia 的 TCC 主体=App 本身（KWS 麦克风同链路已验证），
    // 首次以 MyJavis 名义弹系统摄像头授权；用户点允许 resolve 后才 spawn——同次通话即生效。
    // 拿到立即关流：WebView 不占摄像头，真正采集在探针进程（授权后续次秒过不再弹）。
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.log('[vision] camera permission unavailable:', (e as Error)?.name ?? e);
    return; // 拒绝/无摄像头：不拉探针，通话照常
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
