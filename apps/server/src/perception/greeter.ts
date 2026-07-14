/**
 * ②走开/回来主动打招呼（2026-07-14）：通话中 person_leave → person_enter 事件对触发
 * Javis 主动开口（ExternalTextToSpeech 固定话术，不走 LLM——与 reminder 插播同通道）。
 *
 * 防骚扰四门：离开 ≥30s 才算真离开（低头捡东西不算）/ 离开 >30min 不打（场景已变）/
 * 同租户 10min 冷却 / 无活跃房间静默。状态全内存（零持久化），speak 失败静默。
 */
import { config } from '../config.js';
import { listAgentRooms } from '../routes/rtc.js';
import { speakText } from '../providers/rtc-control.js';

const LEAVE_MIN_MS = 30_000;
const LEAVE_MAX_MS = 30 * 60_000;
const GREET_COOLDOWN_MS = 10 * 60_000;

const GREETINGS = ['欢迎回来～我还在呢。', '回来啦，有事随时叫我。', '欢迎回来，刚才聊到的还要继续吗？'];

interface GreeterDeps {
  listRooms: (tenantId: string) => string[];
  speak: (roomId: string, text: string, interrupt?: boolean) => Promise<void>;
}

const lastLeaveAt = new Map<string, number>();
const lastGreetAt = new Map<string, number>();
let greetSeq = 0; // 话术轮换游标（无随机源依赖，测试可复现）

export function _resetGreeterState(): void {
  lastLeaveAt.clear();
  lastGreetAt.clear();
  greetSeq = 0;
}

export type GreetOutcome =
  | 'greeted'
  | 'disabled'
  | 'ignored'
  | 'no-leave'
  | 'too-short'
  | 'too-long'
  | 'cooldown'
  | 'no-room'
  | 'speak-failed';

/** ingest 收到 L1 事件时调用（fire-and-forget）；返回结果码供测试/日志。 */
export async function maybeGreetOnReturn(
  tenantId: string,
  kind: string,
  now = Date.now(),
  deps: GreeterDeps = { listRooms: listAgentRooms, speak: speakText },
): Promise<GreetOutcome> {
  if (!config.vision.enabled || !config.vision.greetingEnabled) return 'disabled';
  if (kind === 'person_leave') {
    lastLeaveAt.set(tenantId, now);
    return 'ignored';
  }
  if (kind !== 'person_enter') return 'ignored';

  const leftAt = lastLeaveAt.get(tenantId);
  lastLeaveAt.delete(tenantId); // 每个 leave 只配对一次 enter
  if (leftAt === undefined) return 'no-leave';
  const awayMs = now - leftAt;
  if (awayMs < LEAVE_MIN_MS) return 'too-short';
  if (awayMs > LEAVE_MAX_MS) return 'too-long';
  const greetedAt = lastGreetAt.get(tenantId);
  if (greetedAt !== undefined && now - greetedAt < GREET_COOLDOWN_MS) return 'cooldown';
  const rooms = deps.listRooms(tenantId);
  if (!rooms.length) return 'no-room';

  const line = GREETINGS[greetSeq++ % GREETINGS.length]!;
  try {
    // interrupt=false：排队等 Javis 说完再说，不打断进行中的播报
    await deps.speak(rooms[0]!, line, false);
  } catch (err) {
    console.log(`[greeter] speak failed tenant=${tenantId.slice(0, 8)}: ${(err as Error).message.slice(0, 60)}`);
    return 'speak-failed';
  }
  lastGreetAt.set(tenantId, now);
  console.log(`[greeter] greeted tenant=${tenantId.slice(0, 8)} away=${Math.round(awayMs / 1000)}s`);
  return 'greeted';
}
