/**
 * API 统一入口：base 前缀 + 鉴权 header。
 *
 * - `VITE_API_BASE`：空 = 同源相对路径（本地 dev 走 vite proxy）；
 *   Tauri / 生产 build 填公网 server，如 `https://my.chenchuan.cc/myjavis`。
 * - `VITE_JAVIS_API_KEY`：server 侧设了 `JAVIS_API_KEY` 时必须一致（公网 /api/* 防裸奔）。
 *   注意：VITE_ 变量编进 bundle 可被提取，防的是路人扫描不是逆向——更强防护后续走登录态。
 */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '');

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = import.meta.env.VITE_JAVIS_API_KEY as string | undefined;
  const headers = new Headers(init?.headers);
  if (key) headers.set('X-Javis-Key', key);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}
