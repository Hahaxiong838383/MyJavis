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
  /** v0.3 级联：blendshape 高置信瞬时表情（与 emotion 七类正交，探针宁漏勿误门控后才上报）。
   *  v0.3.1 增补 frowning/sad（Owner 拍板 demo 全面测试负面情绪回应）。 */
  expression?: { label: 'smiling' | 'yawning' | 'eyes_closed' | 'frowning' | 'sad'; confidence?: number };
  headPose?: { pitch: number; yaw: number; roll: number };
  attrs?: { eyesOpen?: boolean; mouthOpen?: boolean; glasses?: boolean };
}

/** v0.3 级联：本地物体检测的时间平滑稳定列表（帧/检测框不出采集进程，只有符号）。 */
interface VisionObject {
  label: string;
  labelZh?: string;
  pos?: 'left' | 'center' | 'right';
  confidence: number;
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
  objects?: VisionObject[];
  lastHeartbeatAt: number;
  events: RecentEvent[];
}

export interface VisionStateSnapshot {
  sessionId: string;
  presence: boolean;
  attention: 'screen' | 'away' | 'unknown';
  face?: FaceNode;
  objects?: VisionObject[];
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
    const p = m.payload as { presence?: boolean; attention?: string; face?: FaceNode; objects?: VisionObject[] };
    if (typeof p.presence === 'boolean') st.presence = p.presence;
    st.attention = p.attention === 'screen' || p.attention === 'away' ? p.attention : 'unknown';
    st.face = p.face;
    st.objects = Array.isArray(p.objects) ? p.objects.slice(0, 8) : undefined;
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
    objects: st.objects,
    fresh: agoMs <= HEARTBEAT_FRESH_MS,
    lastHeartbeatAgoMs: agoMs,
    recentEvents: st.events.filter((e) => now - e.at <= EVENT_WINDOW_MS),
  };
}

/**
 * ①reminder 触达联动（2026-07-14）：用户明确不在屏幕前才返回 true——到点提醒跳过
 * RTC 白念，走 fired/App 通知路径。保守语义：无状态/探针离线/在场 一律 false
 * （宁可白念不可漏念，视觉只做纯增益不做扣分项）。
 */
export function isUserAwayFromScreen(tenantId: string, now = Date.now()): boolean {
  if (!config.vision.enabled) return false;
  const s = getVisionState(tenantId, now);
  return Boolean(s && s.fresh && !s.presence);
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
  // v0.3 级联：表情（探针已高置信门控，措辞克制不过度解读）+ 稳定物体列表（本地符号，非画面细节）
  const EXPR_TEXT: Record<string, string> = {
    smiling: '用户脸上带着微笑。',
    yawning: '用户刚打了个哈欠，可能有点困。',
    eyes_closed: '用户闭着眼睛。',
    frowning: '用户皱着眉，看起来有点不高兴或在纠结什么——可以自然地关心一下，或者用你的方式让气氛轻松点。',
    sad: '用户看起来情绪有些低落——适度温柔一点，别硬灌鸡汤。',
  };
  const exprPart = (s.presence && s.face?.expression && EXPR_TEXT[s.face.expression.label]) || '';
  const objs = (s.objects ?? [])
    .slice(0, 5)
    .map((o) => o.labelZh || o.label)
    .join('、');
  const objsPart = objs ? `画面里还能看到：${objs}。` : '';
  const recent = s.recentEvents
    .slice(-3)
    .map((e) => {
      const ago = Math.max(1, Math.round((now - e.at) / 1000));
      return `${ago}秒前${EVENT_LABELS[e.kind] ?? e.kind}`;
    })
    .join('、');
  const recentPart = recent ? `刚刚：${recent}。` : '';
  return (
    `[视觉感知] 你接入了一路摄像头视觉，当前画面：${sight}${exprPart}${objsPart}${recentPart}` +
    `需要时自然地运用这个感知回应（比如用户问"你能看到我吗"就如实描述），只基于以上信息、` +
    `不要脑补画面细节（衣着颜色/文字等你看不到的不要编）。表情/情绪只有上面明确给出时才提；` +
    `没给出时用户问表情，就如实说"看不出有什么特别的表情"，绝不要猜测或用"放松/开心"之类形容凑数。` +
    `画面物体同理：只有上面列出的才算你看到的；用户拿起/指着某个东西问你，而列表里没有，` +
    `就如实说"我没看清那是什么"，绝不要顺着用户的话把它编出来。` +
    `不要念字段名，也不要每轮都主动提你在看着。`
  );
}
