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
/** 哈欠关怀冷却：比打招呼更克制（关怀说多了=唠叨），同租户半小时最多一次。 */
const YAWN_CARE_COOLDOWN_MS = 30 * 60_000;

const GREETINGS = ['欢迎回来～我还在呢。', '回来啦，有事随时叫我。', '欢迎回来，刚才聊到的还要继续吗？'];
const YAWN_CARES = ['有点困了吧？要不要歇一会儿，或者我给你放点轻松的音乐。', '看你打哈欠了——累了就眯一会儿，我不吵你。'];

interface GreeterDeps {
  listRooms: (tenantId: string) => string[];
  speak: (roomId: string, text: string, interrupt?: boolean) => Promise<void>;
}

const lastLeaveAt = new Map<string, number>();
const lastGreetAt = new Map<string, number>();
const lastYawnCareAt = new Map<string, number>();
let greetSeq = 0; // 话术轮换游标（无随机源依赖，测试可复现）
let careSeq = 0;

export function _resetGreeterState(): void {
  lastLeaveAt.clear();
  lastGreetAt.clear();
  lastYawnCareAt.clear();
  lastReactAt.clear();
  lastGlobalReactAt.clear();
  greetSeq = 0;
  careSeq = 0;
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

/**
 * 表情主动交互（2026-07-14 川哥点名扩展）：expression_change 事件驱动，通话中 Javis
 * 主动开口回应表情。话术按 Javis 人格设计（安抚/调侃/陪伴）；eyes_closed 刻意不响应
 * （闭眼=想静静，主动说话是骚扰）。三层防骚扰：每类独立冷却 + 全局主动开口冷却 10min
 * + VISION_GREETING_ENABLED 总开关。
 */
const EXPRESSION_REACTIONS: Record<string, { lines: string[]; cooldownMs: number }> = {
  yawning: {
    lines: YAWN_CARES,
    cooldownMs: YAWN_CARE_COOLDOWN_MS,
  },
  frowning: {
    lines: [
      '看你眉头皱得——遇到什么难题了？说来听听，两个脑子总比一个强。',
      '皱着眉呢。需要我帮你想想，还是给你讲个冷笑话放松一下？',
    ],
    cooldownMs: 30 * 60_000,
  },
  sad: {
    lines: [
      '感觉你情绪不太高……想聊聊吗？不想说也没关系，我陪着。',
      '看你有点蔫，要不要放首你喜欢的歌？',
    ],
    cooldownMs: 30 * 60_000,
  },
  smiling: {
    // 微笑最高频（聊天/看视频都会笑），冷却加倍防骚扰
    lines: ['笑得这么开心，有什么好事儿？分享一下呗。'],
    cooldownMs: 60 * 60_000,
  },
};
/** 全局主动开口冷却：任意两次表情主动交互间隔下限（防连环骚扰）。 */
const GLOBAL_REACT_COOLDOWN_MS = 10 * 60_000;

const lastReactAt = new Map<string, number>(); // `${tenantId}:${expr}` → ts
const lastGlobalReactAt = new Map<string, number>(); // tenantId → ts

export async function maybeReactToExpression(
  tenantId: string,
  toExpression: string,
  now = Date.now(),
  deps: GreeterDeps = { listRooms: listAgentRooms, speak: speakText },
): Promise<GreetOutcome> {
  if (!config.vision.enabled || !config.vision.greetingEnabled) return 'disabled';
  const rule = EXPRESSION_REACTIONS[toExpression];
  if (!rule) return 'ignored'; // neutral/eyes_closed 等不响应
  const key = `${tenantId}:${toExpression}`;
  const reactedAt = lastReactAt.get(key);
  if (reactedAt !== undefined && now - reactedAt < rule.cooldownMs) return 'cooldown';
  const globalAt = lastGlobalReactAt.get(tenantId);
  if (globalAt !== undefined && now - globalAt < GLOBAL_REACT_COOLDOWN_MS) return 'cooldown';
  const rooms = deps.listRooms(tenantId);
  if (!rooms.length) return 'no-room';
  const line = rule.lines[careSeq++ % rule.lines.length]!;
  try {
    await deps.speak(rooms[0]!, line, false);
  } catch (err) {
    console.log(`[greeter] expr-react speak failed tenant=${tenantId.slice(0, 8)}: ${(err as Error).message.slice(0, 60)}`);
    return 'speak-failed';
  }
  lastReactAt.set(key, now);
  lastGlobalReactAt.set(tenantId, now);
  console.log(`[greeter] expr-react tenant=${tenantId.slice(0, 8)} expr=${toExpression}`);
  return 'greeted';
}

/** @deprecated 0.17.2 起由 maybeReactToExpression 统辖；保留别名兼容既有测试。 */
export async function maybeCareOnYawn(
  tenantId: string,
  toExpression: string,
  now = Date.now(),
  deps: GreeterDeps = { listRooms: listAgentRooms, speak: speakText },
): Promise<GreetOutcome> {
  if (toExpression !== 'yawning') {
    if (!config.vision.enabled || !config.vision.greetingEnabled) return 'disabled';
    return 'ignored';
  }
  return maybeReactToExpression(tenantId, toExpression, now, deps);
}
