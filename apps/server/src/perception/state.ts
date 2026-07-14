/**
 * Vision 感知内核（V0，2026-07-14）：契约 v0.2 消费端。
 * 采集端（vision-probe / 未来正式 sidecar）按 contracts/vision/ 契约上报，
 * 本模块做：信封校验 → 租户级 visionState 内存融合 → visionContextNote 生成（注入 LLM）。
 *
 * 红线（docs/VISION-评估与V0方案.md §4）：
 *  - 零持久化：内存 Map only，不落 DB、不进记忆抽取管道；日志不打 payload 全文。
 *  - 契约唯一源头 contracts/vision/（Owner 裁决），本模块只消费不扩展字段。
 */
import { config } from '../config.js';

const CONTRACT_MAJOR = '0'; // 与 contracts/CONTRACT_VERSION 主版本对齐（v0.2.0）
const REQUIRED_FIELDS = ['v', 'type', 'seq', 'session_id', 'ts_mono_ms', 'ts_wall_ms', 'payload'] as const;
const TYPES = new Set(['hello', 'heartbeat', 'event', 'semantic']);
/** 契约 §2 L0：心跳缺失 >3s 即视为采集端离线。 */
const HEARTBEAT_FRESH_MS = 3000;
/** L1 事件注入窗口：只把最近 30s 的离散事件带给 LLM（更久的对当轮对话无意义）。 */
const EVENT_WINDOW_MS = 30_000;
const EVENT_RING_MAX = 8;

export interface PerceptionEnvelope {
  v: string;
  type: 'hello' | 'heartbeat' | 'event' | 'semantic';
  seq: number;
  session_id: string;
  ts_mono_ms: number;
  ts_wall_ms: number;
  payload: Record<string, unknown>;
}

interface FaceNode {
  emotion?: { label: string; confidence?: number };
  headPose?: { pitch: number; yaw: number; roll: number };
  attrs?: { eyesOpen?: boolean; mouthOpen?: boolean; glasses?: boolean };
}

interface RecentEvent {
  kind: string;
  at: number; // 服务端收到时刻（墙钟 ms）
  detail?: string;
}

interface TenantVisionState {
  sessionId: string;
  lastSeq: number;
  presence: boolean;
  attention: 'screen' | 'away' | 'unknown';
  face?: FaceNode;
  lastHeartbeatAt: number;
  events: RecentEvent[];
}

export interface VisionStateSnapshot {
  sessionId: string;
  presence: boolean;
  attention: 'screen' | 'away' | 'unknown';
  face?: FaceNode;
  fresh: boolean;
  lastHeartbeatAgoMs: number;
  recentEvents: RecentEvent[];
}

const states = new Map<string, TenantVisionState>();

export function _resetPerceptionState(): void {
  states.clear();
}

export function validateEnvelope(msg: unknown): { ok: boolean; error?: string } {
  if (typeof msg !== 'object' || msg === null) return { ok: false, error: 'not an object' };
  const m = msg as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((k) => !(k in m));
  if (missing.length) return { ok: false, error: `missing: ${missing.join(',')}` };
  if (!TYPES.has(String(m.type))) return { ok: false, error: `bad type: ${String(m.type)}` };
  if (typeof m.seq !== 'number' || !Number.isInteger(m.seq) || m.seq < 0) return { ok: false, error: 'bad seq' };
  if (typeof m.session_id !== 'string' || m.session_id.length < 8) return { ok: false, error: 'bad session_id' };
  if (typeof m.payload !== 'object' || m.payload === null) return { ok: false, error: 'payload must be object' };
  const major = String(m.v).split('.')[0];
  if (major !== CONTRACT_MAJOR) return { ok: false, error: `contract major mismatch: got ${String(m.v)}` };
  return { ok: true };
}

/**
 * 收一条契约消息进租户状态。返回是否被采纳（同 session 旧 seq 视为乱序/重放，忽略）。
 * now 可注入（测试）；生产用墙钟。
 */
export function ingestPerception(tenantId: string, msg: PerceptionEnvelope | Record<string, unknown>, now = Date.now()): boolean {
  const m = msg as PerceptionEnvelope;
  let st = states.get(tenantId);
  const newSession = !st || st.sessionId !== m.session_id;
  if (newSession) {
    // 新采集进程接管（探针重启 seq 归零合法）；hello/首条消息都走这里。
    st = {
      sessionId: m.session_id,
      lastSeq: -1,
      presence: false,
      attention: 'unknown',
      lastHeartbeatAt: 0,
      events: [],
    };
    states.set(tenantId, st);
  }
  if (!st) return false; // 类型收窄用，逻辑上不可达
  if (m.seq <= st.lastSeq) return false;
  st.lastSeq = m.seq;

  if (m.type === 'heartbeat') {
    const p = m.payload as { presence?: boolean; attention?: string; face?: FaceNode };
    if (typeof p.presence === 'boolean') st.presence = p.presence;
    st.attention = p.attention === 'screen' || p.attention === 'away' ? p.attention : 'unknown';
    st.face = p.face;
    st.lastHeartbeatAt = now;
  } else if (m.type === 'event') {
    const p = m.payload as { kind?: string; direction?: string; to?: string };
    if (p.kind) {
      st.events.push({ kind: p.kind, at: now, detail: p.direction ?? p.to });
      if (st.events.length > EVENT_RING_MAX) st.events.splice(0, st.events.length - EVENT_RING_MAX);
    }
  }
  // hello/semantic：V0 只推进 seq（hello 已由 newSession 分支接管；L2 场景描述留 P4）。
  return true;
}

export function getVisionState(tenantId: string, now = Date.now()): VisionStateSnapshot | undefined {
  const st = states.get(tenantId);
  if (!st) return undefined;
  const agoMs = st.lastHeartbeatAt ? now - st.lastHeartbeatAt : Number.POSITIVE_INFINITY;
  return {
    sessionId: st.sessionId,
    presence: st.presence,
    attention: st.attention,
    face: st.face,
    fresh: agoMs <= HEARTBEAT_FRESH_MS,
    lastHeartbeatAgoMs: agoMs,
    recentEvents: st.events.filter((e) => now - e.at <= EVENT_WINDOW_MS),
  };
}

const EVENT_LABELS: Record<string, string> = {
  person_enter: '回到画面中',
  person_leave: '离开了画面',
  gaze_shift: '视线转移',
  head_nod: '点了点头',
  head_shake: '摇了摇头',
  head_tilt: '歪了歪头',
  expression_change: '表情变化',
  gesture: '做了个手势',
};

/**
 * 生成注入 LLM 的视觉上下文（无状态/离线/开关关 → undefined = 完全不注入，现有行为零影响）。
 * 文案只用稳定语义（presence/attention/近期事件）；face 细节（角度/attrs）噪声大不进 prompt，
 * 留在 GET /state 快照里供调试与后续 P3 消费。
 */
export function buildVisionContextNote(tenantId: string, now = Date.now()): string | undefined {
  if (!config.vision.enabled) return undefined;
  const s = getVisionState(tenantId, now);
  if (!s || !s.fresh) return undefined;

  let sight: string;
  if (!s.presence) {
    sight = '摄像头画面里现在没有人，用户可能暂时离开了座位。';
  } else if (s.attention === 'screen') {
    sight = '用户正坐在屏幕前，看着屏幕（面向你）。';
  } else if (s.attention === 'away') {
    sight = '用户在座位上，但视线不在屏幕上（可能在看别处或低头做事）。';
  } else {
    sight = '用户在摄像头画面中。';
  }
  const recent = s.recentEvents
    .slice(-3)
    .map((e) => {
      const ago = Math.max(1, Math.round((now - e.at) / 1000));
      return `${ago}秒前${EVENT_LABELS[e.kind] ?? e.kind}`;
    })
    .join('、');
  const recentPart = recent ? `刚刚：${recent}。` : '';
  return (
    `[视觉感知] 你接入了一路摄像头视觉，当前画面：${sight}${recentPart}` +
    `需要时自然地运用这个感知回应（比如用户问"你能看到我吗"就如实描述），` +
    `不要念字段名，也不要每轮都主动提你在看着。`
  );
}
