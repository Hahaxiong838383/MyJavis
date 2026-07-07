/**
 * reminder 调度器：30s tick 扫到期提醒，按三档触达路由（ROADMAP §2.1）。
 *
 *  档1 通话中：该租户有活跃 RTC 房间 → ExternalTextToSpeech 插播（音乐守护 save 模式下
 *      任务已停会失败 → 自然降级档2，此时 App 一定开着，通知+念出可达）。
 *  档2 App 开着：置 fired，App 轮询 /api/reminders/due 接走（通知+speechSynthesis）→ ack。
 *  档3 都不在：fired 超 30min 无人接 → missed；下次通话首轮 contextNote 补报。
 */
import { speakText } from '../providers/rtc-control.js';
import { listAgentRooms } from '../routes/rtc.js';
import { fireLine } from './intent.js';
import { reminderStore } from './store.js';

const TICK_MS = Number(process.env.REMINDER_TICK_MS ?? 30_000); // 测试可调小，生产默认 30s
const FIRED_EXPIRE_MS = 30 * 60_000;

let timer: ReturnType<typeof setInterval> | undefined;

export function startReminderScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    tickOnce().catch((err) => console.log(`[reminder] tick error: ${(err as Error).message}`));
  }, TICK_MS);
  timer.unref?.(); // 不阻止进程退出（测试/优雅停机）
  console.log('[reminder] scheduler started (tick 30s)');
}

export function stopReminderScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** 单轮 tick（导出供测试直调）。 */
export async function tickOnce(now = Date.now()): Promise<void> {
  const store = reminderStore();
  const due = store.duePending(now);
  for (const r of due) {
    const rooms = listAgentRooms(r.tenantId);
    let delivered = false;
    for (const roomId of rooms) {
      try {
        await speakText(roomId, fireLine(r.speakerName, r.content), false);
        store.markDelivered(r.id, 'rtc');
        console.log(`[reminder] delivered via rtc id=${r.id} room=${roomId} "${r.content.slice(0, 20)}"`);
        delivered = true;
        break;
      } catch (err) {
        // 房间在册但任务已停（音乐守护 save 模式）/已死 → 试下一个房间，全败降级 fired
        console.log(`[reminder] rtc speak failed room=${roomId}: ${(err as Error).message.slice(0, 80)}`);
      }
    }
    if (!delivered) {
      store.markFired(r.id);
      console.log(`[reminder] fired (await app poll) id=${r.id} "${r.content.slice(0, 20)}"`);
    }
  }
  const expired = store.expireFired(FIRED_EXPIRE_MS, now);
  if (expired > 0) console.log(`[reminder] ${expired} fired reminder(s) expired to missed`);
}
