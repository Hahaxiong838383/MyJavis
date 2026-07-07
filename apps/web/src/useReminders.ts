/**
 * reminder 触达档2（App 开着，含最小化）：独立于通话的后台轮询 /api/reminders/due，
 * 到点 → 系统通知（Tauri notification 插件，浏览器环境降级跳过）+ speechSynthesis 本地念出
 * （零计费，不拉火山房间）→ ack 回执。通话中的提醒由 server 直接 RTC 插播（档1），不会进 due。
 *
 * ⚠️ 轮询 effect 依赖必须为空数组（react_effect_dep_churn 教训：依赖高频状态会反复拆建
 * interval 掐掉轮询）；会话内 seen 集合防 ack 失败时同条重复念。
 */
import { useEffect } from 'react';
import { apiFetch } from './api';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface ReminderDto {
  id: string;
  content: string;
  dueAt: number;
  status: 'pending' | 'fired' | 'delivered' | 'missed' | 'cancelled';
  speakerName?: string;
}

/** 启动时预请求通知权限（第一条提醒到达时才弹权限框的话，用户很可能不在电脑前）。 */
async function warmupNotifyPermission(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    /* 插件不可用：忽略 */
  }
}

async function notifySystem(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch {
    /* 插件不可用/权限被拒：speechSynthesis 念出仍是主触达 */
  }
}

function speak(text: string): void {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    window.speechSynthesis.speak(u);
  } catch {
    /* 无 TTS 环境（无头浏览器等）静默 */
  }
}

const POLL_MS = 15_000;

/** App 根组件调用一次；未激活（无邀请码）时 401 静默，激活后自然生效。 */
export function useReminderDelivery(): void {
  useEffect(() => {
    void warmupNotifyPermission();
    const seen = new Set<string>();
    const tick = async (): Promise<void> => {
      try {
        const res = await apiFetch('/api/reminders/due');
        if (!res.ok) return; // 401（未激活）/5xx：下轮再试
        const data = (await res.json()) as { ok: boolean; items?: ReminderDto[] };
        for (const r of data.items ?? []) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          const line = `${r.speakerName ? `${r.speakerName}，` : ''}提醒时间到了：${r.content}`;
          void notifySystem('Javis 提醒', r.content);
          speak(line);
          console.log(`[reminder] delivered via app id=${r.id} "${r.content.slice(0, 20)}"`);
          apiFetch(`/api/reminders/${r.id}/ack`, { method: 'POST' }).catch(() => seen.delete(r.id));
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
