/**
 * API 统一入口：base 前缀 + 鉴权 header。
 *
 * - `VITE_API_BASE`：空 = 同源相对路径（本地 dev 走 vite proxy）；
 *   Tauri / 生产 build 填公网 server，如 `https://javis.chenchuan.cc`。
 * - 鉴权 key 优先级（批次B 多租户）：localStorage 邀请码（用户激活页输入）>
 *   `VITE_JAVIS_API_KEY`（开发者本机 dev 便利）。
 *   ⚠️ 分发 build 的 .env.local 必须留空 VITE_JAVIS_API_KEY（admin key 绝不能编进用户 bundle），
 *   分发版用户一律走激活页输入邀请码。
 */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '');

const TOKEN_STORAGE_KEY = 'jv_invite_token';

export function getInviteToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setInviteToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    /* localStorage 不可用（隐私模式等）时降级为会话内不持久 */
  }
}

export function clearInviteToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function currentApiKey(): string {
  return getInviteToken() || ((import.meta.env.VITE_JAVIS_API_KEY as string | undefined) ?? '');
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = currentApiKey();
  const headers = new Headers(init?.headers);
  if (key) headers.set('X-Javis-Key', key);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}
