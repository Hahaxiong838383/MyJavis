/**
 * 火山 RTC 实时对话接入（抽取自 P003 routes/rtc.ts，剥离登录/onboarding/吐槽业务）。
 *
 * 前端调本路由拿 RTC token + 起 AI agent。凭证全在 server 端组装、不下发前端，
 * 前端只拿到 { appId, roomId, userId, token, taskId }。
 *
 * 链路：前端进房 → 火山 RTC 起 AI（火山 ASR + Doubao TTS + CustomLLM 回调我方 /v1 大脑）→ 全双工。
 */
import { Hono } from 'hono';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setPromptOverride, clearPromptOverride } from '../rtc-prompt-override.js';
import { callRtcOpenAPI } from '../providers/volc-openapi.js';
import { listActiveVoiceprints } from '../voiceprint/registry.js';
import { clearFreshEnrollName } from '../voiceprint/enroll-session.js';
import { effectiveTenant, type AppEnv } from '../tenant/context.js';
import {
  activePublicVoicePolicyCount,
  createPublicVoiceProof,
  deletePublicVoicePolicy,
  registerPublicVoicePolicy,
} from '../public-voice/policy.js';
import { resolvePublicVoiceTuning } from '../public-voice/tuning.js';

const require = createRequire(import.meta.url);
// 火山 RTC token 私有格式（二进制 HMAC），原样复用火山官方 token.cjs（不移植避免 bug）。
const { AccessToken, privileges } = require('../rtc-token.cjs') as {
  AccessToken: new (appId: string, appKey: string, roomId: string, userId: string) => {
    addPrivilege: (priv: number, expireTs: number) => void;
    expireTime: (ts: number) => void;
    serialize: () => string;
  };
  privileges: { PrivPublishStream: number; PrivSubscribeStream: number };
};

const rtcRoute = new Hono<AppEnv>();
// 火山 CustomLLM 回调地址：必须公网 HTTPS（火山云回调我方大脑端点）。本地验证可设隧道地址。
const CUSTOM_LLM_URL = process.env.CUSTOM_LLM_URL || 'https://example.com/v1/chat/completions';
const WELCOME = process.env.RTC_WELCOME_MESSAGE || '你好，我在听，有什么可以帮你的？';
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_TIME_MS ?? 450);
// AIVAD 智能语义断句（2024-12-01 版合法，发版说明 2025-08-27，PDF 页7329）：LLM 判断语义
// 完整性+静音双重断句，治长句/报数字被抢话。注意：与 SilenceTime=300 组合超出官方推荐
// （官方建议 AIVAD 配 1000ms+ 给语义判断留窗口），行为以川哥实测为准。VAD_AIVAD=0 回滚。
const VAD_AIVAD = (process.env.VAD_AIVAD ?? '0') === '1';
// Prefill：火山把 ASR 中间结果提前发给 LLM"边听边想"（官方 PDF 页7401/7620，代价=额外模型调用）。
// LLM_PREFILL=0 关闭（回滚点）。custom-llm 侧有 abort 守卫防 interim 污染记忆。
const LLM_PREFILL = (process.env.LLM_PREFILL ?? '0') === '1';
// 打断保护（PDF 页7649：InterruptSpeechDuration 默认 0=有真实语义人声即掐 TTS——多人/环境音
// 场景 TTS 被反复掐断，体感"忽大忽小"）。800=持续说 0.8s 才打断；官方多人场景建议 1500+；
// 打断后说话仍由 SilenceTime+AIVAD 正常判停。0=不发字段（回滚）。取值 0 或 [200,3000]。
const INTERRUPT_SPEECH_MS = Number(process.env.INTERRUPT_SPEECH_MS ?? 800);

/** 拼 custom-llm 回调 URL：?session=roomId + ?tenant=（租户上下文）+ 可选 ?user=（mock 调试键）。 */
function buildCustomLlmUrl(roomId: string, tenantId?: string, userId?: string, publicProof?: string): string {
  const params = new URLSearchParams();
  params.set('session', roomId);
  if (tenantId) params.set('tenant', tenantId);
  if (userId) params.set('user', userId);
  if (publicProof) params.set('public_proof', publicProof);
  return `${CUSTOM_LLM_URL}?${params.toString()}`;
}

type VoiceMode = 'identify' | 'denoise';

interface VoiceChatOptions {
  memoryUser?: string;
  tenantId?: string;
  voiceMode: VoiceMode;
  voiceprintIds: string[];
  voiceprintScore: number;
  /** resume-agent 用：覆盖 welcome（置空防止重启任务时重播开场白）。undefined=用默认。 */
  welcomeOverride?: string;
  /** 公开会话回调证明；用于进程重启后仍保持无记忆隔离。 */
  publicProof?: string;
}

/**
 * 房间级会话参数（音乐守护"省钱模式"的 pause/resume-agent 用）：
 * resume 重启任务必须复用原 userId（前端还在房间里用这个身份），memoryUser/voiceMode 同理。
 * 内存态，server 重启丢失可接受（房间生命周期短于 server 运行周期）。
 */
interface AgentSession {
  userId: string;
  tenantId?: string;
  memoryUser?: string;
  voiceMode: VoiceMode;
  voiceprintScore: number;
  startedAt: number;
  mode: 'private' | 'public_mirror';
}

const agentSessions = new Map<string, AgentSession>();
const publicSessionTimers = new Map<string, NodeJS.Timeout>();

/**
 * R3.1 并发闸门（2026-07-08 川哥拍板堵口子）：此前任何激活租户可无限开房，
 * 每路都在烧火山任务钱；且关 App 不调 /stop 会留僵尸房（注册表残留+火山任务空转）。
 * - 每租户上限（默认 1）：新 start 先踢自己的旧房（旧房大概率是没正常关闭的僵尸，
 *   踢旧保新对"重开 App 重连"场景最友好）
 * - 全局上限（默认 8）：为火山账号并发配额留余量，超限 429 友好话术
 * - 僵尸兜底：在册超 4h 判僵尸（正常通话不会这么长），start 时顺手清扫
 */
const MAX_ROOMS_PER_TENANT = Number(process.env.MAX_ROOMS_PER_TENANT ?? 1);
const MAX_GLOBAL_ROOMS = Number(process.env.MAX_GLOBAL_ROOMS ?? 8);
const ROOM_ZOMBIE_TTL_MS = Number(process.env.ROOM_ZOMBIE_TTL_MS ?? 4 * 3600_000);
const MAX_PUBLIC_ROOMS = Number(process.env.MAX_PUBLIC_VOICE_ROOMS ?? 2);

/** 尽力停房：火山任务 StopVoiceChat（失败忽略——可能早已自停）+ 本地注册/override 清理。 */
async function stopRoomBestEffort(roomId: string, reason: string): Promise<void> {
  clearPromptOverride(roomId);
  clearFreshEnrollName(roomId);
  deletePublicVoicePolicy(roomId);
  const timer = publicSessionTimers.get(roomId);
  if (timer) clearTimeout(timer);
  publicSessionTimers.delete(roomId);
  agentSessions.delete(roomId);
  try {
    await callRtcOpenAPI('StopVoiceChat', {
      AppId: process.env.VOLC_RTC_APP_ID,
      RoomId: roomId,
      TaskId: roomId,
    });
    console.log(`[rtc] room evicted (${reason}) room=${roomId}`);
  } catch {
    console.log(`[rtc] room evict stop-call failed (ignored, ${reason}) room=${roomId}`);
  }
}

async function sweepZombieRooms(now = Date.now()): Promise<void> {
  for (const [roomId, sess] of agentSessions) {
    if (now - sess.startedAt > ROOM_ZOMBIE_TTL_MS) await stopRoomBestEffort(roomId, 'zombie-ttl');
  }
}

/** 观测用：当前在册房间总数。 */
export function activeRoomCount(): number {
  return agentSessions.size;
}

/** 该租户当前在册的房间（reminder 调度器档1路由用）。房间在册≠任务活着（音乐守护
 *  save 模式任务已停），调用方对 ExternalTextToSpeech 失败必须降级处理。 */
export function listAgentRooms(tenantId: string): string[] {
  const rooms: string[] = [];
  for (const [roomId, sess] of agentSessions) {
    if (sess.mode === 'private' && sess.tenantId === tenantId) rooms.push(roomId);
  }
  return rooms;
}

export interface PublicVoiceSessionResult {
  appId: string;
  roomId: string;
  userId: string;
  token: string;
  taskId: string;
  expiresAt: number;
  maxSeconds: number;
}

/** 个人站 BFF 专用访客会话。它不带租户、声纹和记忆，并由服务端硬超时回收。 */
export async function startPublicVoiceSession(input: {
  systemPrompt: string;
  promptVersion: string;
  maxSeconds: number;
}): Promise<PublicVoiceSessionResult> {
  const appId = process.env.VOLC_RTC_APP_ID;
  const appKey = process.env.VOLC_RTC_APP_KEY;
  if (!appId || !appKey || !process.env.VOLC_ACCESS_KEY_ID || !process.env.VOLC_SECRET_ACCESS_KEY) {
    throw new Error('rtc_not_configured');
  }

  await sweepZombieRooms();
  if (agentSessions.size >= MAX_GLOBAL_ROOMS || activePublicVoicePolicyCount() >= MAX_PUBLIC_ROOMS) {
    throw new Error('public_voice_busy');
  }

  const roomId = `public-mirror-${randomUUID()}`;
  const userId = `guest-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const expiresAt = now + input.maxSeconds * 1000;
  const key = new AccessToken(appId, appKey, roomId, userId);
  key.addPrivilege(privileges.PrivSubscribeStream, 0);
  key.addPrivilege(privileges.PrivPublishStream, 0);
  key.expireTime(Math.floor(expiresAt / 1000) + 60);
  const token = key.serialize();

  // 先注册可信策略，避免火山任务启动后首个回调抢在本地登记之前到达。
  registerPublicVoicePolicy({
    roomId,
    systemPrompt: input.systemPrompt,
    promptVersion: input.promptVersion,
    createdAt: now,
    expiresAt,
  });

  const tuning = resolvePublicVoiceTuning();
  console.log(
    `[rtc] public tuning vad=${tuning.vadSilenceMs}ms aivad=${tuning.vadAivad ? 1 : 0}` +
      ` interrupt=${tuning.interruptSpeechMs}ms prefill=${tuning.llmPrefill ? 1 : 0}` +
      ` filler=${tuning.fillerEnabled ? 1 : 0}`,
  );

  let result;
  try {
    result = await callRtcOpenAPI(
      'StartVoiceChat',
      buildVoiceChatConfig(roomId, userId, {
        voiceMode: 'identify',
        voiceprintIds: [],
      voiceprintScore: 50,
      welcomeOverride: '我是陈川的 AI 战略镜像，不是陈川本人。我们可以实时聊两分钟，你随时可以打断我。',
      publicProof: createPublicVoiceProof(roomId),
      }),
    );
  } catch (error) {
    deletePublicVoicePolicy(roomId);
    throw error;
  }
  const err = result?.ResponseMetadata?.Error;
  if (err) {
    deletePublicVoicePolicy(roomId);
    throw new Error(`${err.Code}: ${err.Message}`);
  }

  agentSessions.set(roomId, {
    userId,
    voiceMode: 'identify',
    voiceprintScore: 50,
    startedAt: now,
    mode: 'public_mirror',
  });
  const timer = setTimeout(() => {
    void stopRoomBestEffort(roomId, 'public-hard-timeout');
  }, input.maxSeconds * 1000);
  timer.unref();
  publicSessionTimers.set(roomId, timer);
  console.log(`[rtc] public mirror started room=${roomId} ttl=${input.maxSeconds}s prompt=${input.promptVersion}`);

  return { appId, roomId, userId, token, taskId: roomId, expiresAt, maxSeconds: input.maxSeconds };
}

export async function stopPublicVoiceSession(roomId: string, reason: string): Promise<boolean> {
  const session = agentSessions.get(roomId);
  if (session && session.mode !== 'public_mirror') return false;
  // 服务重启后注册表会丢；共享密钥鉴权后的控制面仍可按不可伪造前缀回收火山任务。
  if (!session && !roomId.startsWith('public-mirror-')) return false;
  await stopRoomBestEffort(roomId, reason);
  return true;
}

/** server 端组装 StartVoiceChat 的 VoiceChat 配置（凭证从 env，不下发前端）。 */
function buildVoiceChatConfig(roomId: string, userId: string, opts: VoiceChatOptions): Record<string, unknown> {
  const publicTuning = opts.publicProof ? resolvePublicVoiceTuning() : undefined;
  const vadSilenceMs = publicTuning?.vadSilenceMs ?? VAD_SILENCE_MS;
  const vadAivad = publicTuning?.vadAivad ?? VAD_AIVAD;
  const interruptSpeechMs = publicTuning?.interruptSpeechMs ?? INTERRUPT_SPEECH_MS;
  const llmPrefill = publicTuning?.llmPrefill ?? LLM_PREFILL;
  const voicePrint =
    opts.voiceMode === 'denoise'
      ? { Mode: 1, IdList: opts.voiceprintIds.slice(0, 1), EnableSV: true }
      : { Mode: 2, IdList: opts.voiceprintIds.slice(0, 3), Score: opts.voiceprintScore };
  return {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: roomId, // 一房一任务（火山要求 TaskId 非空）
    AgentConfig: {
      TargetUserId: [userId],
      WelcomeMessage: opts.welcomeOverride !== undefined ? opts.welcomeOverride : WELCOME,
      UserId: 'myjavis_bot', // ★ 必须 ASCII，中文报 invalid UserID
      EnableConversationStateCallback: true,
      ...(opts.voiceprintIds.length > 0 ? { VoicePrint: voicePrint } : {}),
    },
    Config: {
      ASRConfig: {
        // ⚠️ 字段必须有官方文档背书才能加——火山 preParamCheck 对本版本(2024-12-01)不认识的
        //    字段拒整段（踩过 StreamMode=2025-06-01 版专属字段 → ASR 降级「出字幕不提交 LLM」）。
        Provider: 'volcano',
        ProviderParams: {
          Mode: 'bigmodel',
          AppId: process.env.VOLC_ASR_APP_ID,
          AccessToken: process.env.VOLC_ASR_ACCESS_TOKEN,
          ApiResourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',
        },
        // 判停时长（官方 PDF 页6553/7473：默认 600ms，快问答可调短；文档承认 600 对快节奏"体感延迟"）。
        // 450 = 快接上；若句中思考停顿被切（抢话）→ 调回 500-550 或开 AIVAD。0 = 不发此字段（回滚）。
        ...(vadSilenceMs > 0
          ? { VADConfig: { SilenceTime: vadSilenceMs, ...(vadAivad ? { AIVAD: true } : {}) } }
          : {}),
        ...(interruptSpeechMs > 0
          ? { InterruptConfig: { InterruptSpeechDuration: interruptSpeechMs } }
          : {}),
      },
      TTSConfig: {
        Provider: 'volcano_bidirection',
        ProviderParams: {
          // ⚠️ P003 坑：火山收紧 volcano_bidirection schema，cluster/loudness_ratio 已成非法字段
          //    （unknown fields → 拒整个 TTSConfig → 静音）。只留 app.appid + app.token。
          app: {
            appid: process.env.VOLC_TTS_APP_ID,
            token: process.env.VOLC_TTS_ACCESS_TOKEN,
          },
          audio: {
            voice_type: process.env.VOLC_TTS_VOICE || 'zh_female_tianmeixiaoyuan_moon_bigtts',
            speech_rate: 0,
            pitch_rate: 0,
          },
          ResourceId: process.env.VOLC_TTS_RESOURCE_ID || 'volc.service_type.10029',
        },
      },
      LLMConfig: {
        Mode: 'CustomLLM',
        Url: buildCustomLlmUrl(roomId, opts.tenantId, opts.memoryUser, opts.publicProof),
        ModelName: 'myjavis',
        APIKey: process.env.CUSTOM_LLM_API_KEY || 'none',
        SystemMessages: [],
        ...(llmPrefill ? { Prefill: true } : {}),
      },
      InterruptMode: 0, // 0=可打断（全双工 barge-in）
    },
  };
}

/**
 * 起一局实时语音：生成 RTC token + 起 AI agent。
 * body（均可选）：{ systemPrompt?: 调试台实时 prompt; userId?: 记忆注入键; voiceMode?: identify|denoise; voiceprintIds?: string[] }
 * 返回前端进房所需（凭证不含）：{ appId, roomId, userId, token, taskId }。
 */
rtcRoute.post('/start', async (c) => {
  const appId = process.env.VOLC_RTC_APP_ID;
  const appKey = process.env.VOLC_RTC_APP_KEY;
  if (!appId || !appKey) {
    return c.json({ ok: false, error: 'RTC 未配置（VOLC_RTC_APP_ID/KEY）' }, 500);
  }
  if (!process.env.VOLC_ACCESS_KEY_ID || !process.env.VOLC_SECRET_ACCESS_KEY) {
    return c.json({ ok: false, error: 'OpenAPI AK/SK 未配置（VOLC_ACCESS_KEY_ID/SECRET）' }, 500);
  }
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: '无租户上下文（邀请码无效或未激活）' }, 401);

  // —— R3.1 并发闸门 ——
  await sweepZombieRooms();
  const myRooms = listAgentRooms(tenant.id);
  if (myRooms.length >= MAX_ROOMS_PER_TENANT) {
    // 踢旧保新：同码重复开房 = 上一个房没正常关闭（关 App/断网/换设备）
    for (const old of myRooms) await stopRoomBestEffort(old, `tenant-cap tenant=${tenant.id}`);
  }
  if (agentSessions.size >= MAX_GLOBAL_ROOMS) {
    console.log(`[rtc] global room cap hit (${agentSessions.size}/${MAX_GLOBAL_ROOMS}), tenant=${tenant.id} rejected`);
    return c.json({ ok: false, error: '现在使用的人比较多，稍等一会儿再试～' }, 429);
  }

  // 开场白租户化：设置了称呼就用称呼打招呼（曾是 env 硬编码"你好川哥"——多租户后按人拼）
  const welcome = tenant.userTitle?.trim() ? `你好${tenant.userTitle.trim()}，我是 Javis，随时吩咐。` : WELCOME;

  const roomId = `myjavis-${randomUUID()}`;
  const userId = `user-${randomUUID().slice(0, 8)}`;

  const startBody = (await c.req.json().catch(() => ({}))) as {
    systemPrompt?: string;
    userId?: string;
    voiceMode?: VoiceMode;
    voiceprintIds?: string[];
    voiceprintScore?: number;
  };
  if (startBody.systemPrompt?.trim()) {
    setPromptOverride(roomId, startBody.systemPrompt);
    console.log(`[rtc] prompt override set room=${roomId} (${startBody.systemPrompt.length} 字符)`);
  }
  const memoryUser = startBody.userId?.trim() || undefined;
  const voiceMode: VoiceMode = startBody.voiceMode === 'denoise' ? 'denoise' : 'identify';
  // 声纹 IdList 来源优先级：body 显式（调试）> env VOLC_VOICEPRINT_IDS（调试）> 本租户 registry（正常路径）
  const explicitIds =
    startBody.voiceprintIds?.filter((id) => id.trim()).map((id) => id.trim()) ??
    (process.env.VOLC_VOICEPRINT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  const registryIds = explicitIds.length === 0 ? listActiveVoiceprints(tenant.id).map((r) => r.voiceprintId) : [];
  const voiceprintIds = explicitIds.length > 0 ? explicitIds : registryIds;
  const voiceprintScore = Number.isFinite(startBody.voiceprintScore) ? Number(startBody.voiceprintScore) : 50;

  // RTC token（订阅 + 发布权限，24h 过期）
  const key = new AccessToken(appId, appKey, roomId, userId);
  key.addPrivilege(privileges.PrivSubscribeStream, 0);
  key.addPrivilege(privileges.PrivPublishStream, 0);
  key.expireTime(Math.floor(Date.now() / 1000) + 24 * 3600);
  const token = key.serialize();

  // 起 AI agent（火山起 task，AI 回调我方 /v1 大脑）
  const result = await callRtcOpenAPI(
    'StartVoiceChat',
    buildVoiceChatConfig(roomId, userId, {
      memoryUser,
      tenantId: tenant.id,
      voiceMode,
      voiceprintIds,
      voiceprintScore,
      welcomeOverride: welcome,
    }),
  );
  const err = result?.ResponseMetadata?.Error;
  if (err) {
    console.log(`[rtc] StartVoiceChat failed: ${err.Code} ${err.Message}`);
    return c.json({ ok: false, error: `${err.Code}: ${err.Message}` }, 502);
  }

  console.log(
    `[rtc] started room=${roomId} user=${userId} voiceMode=${voiceMode} voiceprints=${voiceprintIds.length} welcome="${welcome.slice(0, 12)}…"`,
  );
  agentSessions.set(roomId, {
    userId,
    tenantId: tenant.id,
    memoryUser,
    voiceMode,
    voiceprintScore,
    startedAt: Date.now(),
    mode: 'private',
  });
  return c.json({ ok: true, appId, roomId, userId, token, taskId: roomId, voiceMode, voiceprintCount: voiceprintIds.length });
});

/**
 * 音乐守护"省钱模式"：暂停 AI 任务（StopVoiceChat）。房间和用户不动，只停 AI agent
 * （零空转计费）；resume-agent 同房间重启。⚠️ 火山任务停止即丢对话 history（省钱模式
 * 固有代价，D1 拍板已知悉）。不清 promptOverride（区别于 /stop 的完整清理）。
 */
rtcRoute.post('/pause-agent', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string };
  const roomId = body.roomId?.trim();
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  const result = await callRtcOpenAPI('StopVoiceChat', {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: roomId,
  });
  const err = result?.ResponseMetadata?.Error;
  if (err) {
    console.log(`[rtc] pause-agent failed room=${roomId}: ${err.Code} ${err.Message}`);
    return c.json({ ok: false, error: `${err.Code}: ${err.Message}` }, 502);
  }
  console.log(`[rtc] agent paused (save mode) room=${roomId}`);
  return c.json({ ok: true });
});

/**
 * 音乐守护"省钱模式"：唤醒时同房间重启 AI 任务。welcome 置空（不重播开场白）；
 * 声纹 IdList 从 registry 现拉（副作用红利：新注册声纹重启即生效）。
 */
rtcRoute.post('/resume-agent', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string };
  const roomId = body.roomId?.trim();
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  const sess = agentSessions.get(roomId);
  if (!sess || sess.mode !== 'private' || !sess.tenantId) {
    return c.json({ ok: false, error: 'unknown room（server 可能重启过，请重新开始对话）' }, 404);
  }
  const voiceprintIds = listActiveVoiceprints(sess.tenantId).map((r) => r.voiceprintId);
  const result = await callRtcOpenAPI(
    'StartVoiceChat',
    buildVoiceChatConfig(roomId, sess.userId, {
      memoryUser: sess.memoryUser,
      tenantId: sess.tenantId,
      voiceMode: sess.voiceMode,
      voiceprintIds,
      voiceprintScore: sess.voiceprintScore,
      welcomeOverride: '', // 唤醒重启不重播开场白
    }),
  );
  const err = result?.ResponseMetadata?.Error;
  if (err) {
    console.log(`[rtc] resume-agent failed room=${roomId}: ${err.Code} ${err.Message}`);
    return c.json({ ok: false, error: `${err.Code}: ${err.Message}` }, 502);
  }
  console.log(`[rtc] agent resumed room=${roomId} voiceprints=${voiceprintIds.length}`);
  return c.json({ ok: true });
});

/** 停止本局（前端离房时调）。 */
rtcRoute.post('/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string; taskId?: string };
  const roomId = body.roomId;
  const taskId = body.taskId || roomId;
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  if (agentSessions.get(roomId)?.mode === 'public_mirror') {
    return c.json({ ok: false, error: 'unknown room' }, 404);
  }
  clearPromptOverride(roomId);
  clearFreshEnrollName(roomId);
  agentSessions.delete(roomId);
  const result = await callRtcOpenAPI('StopVoiceChat', {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: taskId,
  });
  return c.json({ ok: true, result });
});

/** 调试台改 prompt 热更新：不重连，更新该房间 override，下一轮 custom-llm 回调即用新 prompt。 */
rtcRoute.post('/update-prompt', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string; systemPrompt?: string };
  if (!body.roomId || !body.systemPrompt?.trim()) {
    return c.json({ ok: false, error: 'roomId + systemPrompt 必填' }, 400);
  }
  setPromptOverride(body.roomId, body.systemPrompt);
  console.log(`[rtc] prompt override updated room=${body.roomId} (${body.systemPrompt.length} 字符)`);
  return c.json({ ok: true });
});

export { rtcRoute };
