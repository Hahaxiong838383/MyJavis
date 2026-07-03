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

const rtcRoute = new Hono();
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

/** 拼 custom-llm 回调 URL：?session=roomId（prompt override 键）+ 可选 ?user=（记忆注入键）。 */
function buildCustomLlmUrl(roomId: string, userId?: string): string {
  const params = new URLSearchParams();
  params.set('session', roomId);
  if (userId) params.set('user', userId);
  return `${CUSTOM_LLM_URL}?${params.toString()}`;
}

type VoiceMode = 'identify' | 'denoise';

interface VoiceChatOptions {
  memoryUser?: string;
  voiceMode: VoiceMode;
  voiceprintIds: string[];
  voiceprintScore: number;
}

/** server 端组装 StartVoiceChat 的 VoiceChat 配置（凭证从 env，不下发前端）。 */
function buildVoiceChatConfig(roomId: string, userId: string, opts: VoiceChatOptions): Record<string, unknown> {
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
      WelcomeMessage: WELCOME,
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
        ...(VAD_SILENCE_MS > 0
          ? { VADConfig: { SilenceTime: VAD_SILENCE_MS, ...(VAD_AIVAD ? { AIVAD: true } : {}) } }
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
        Url: buildCustomLlmUrl(roomId, opts.memoryUser),
        ModelName: 'myjavis',
        APIKey: process.env.CUSTOM_LLM_API_KEY || 'none',
        SystemMessages: [],
        ...(LLM_PREFILL ? { Prefill: true } : {}),
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
  // 声纹 IdList 来源优先级：body 显式（调试）> env VOLC_VOICEPRINT_IDS（调试）> registry 自动（正常路径）
  const explicitIds =
    startBody.voiceprintIds?.filter((id) => id.trim()).map((id) => id.trim()) ??
    (process.env.VOLC_VOICEPRINT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  const registryIds = explicitIds.length === 0 ? listActiveVoiceprints().map((r) => r.voiceprintId) : [];
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
    buildVoiceChatConfig(roomId, userId, { memoryUser, voiceMode, voiceprintIds, voiceprintScore }),
  );
  const err = result?.ResponseMetadata?.Error;
  if (err) {
    console.log(`[rtc] StartVoiceChat failed: ${err.Code} ${err.Message}`);
    return c.json({ ok: false, error: `${err.Code}: ${err.Message}` }, 502);
  }

  console.log(`[rtc] started room=${roomId} user=${userId} voiceMode=${voiceMode} voiceprints=${voiceprintIds.length}`);
  return c.json({ ok: true, appId, roomId, userId, token, taskId: roomId, voiceMode, voiceprintCount: voiceprintIds.length });
});

/** 停止本局（前端离房时调）。 */
rtcRoute.post('/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string; taskId?: string };
  const roomId = body.roomId;
  const taskId = body.taskId || roomId;
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  clearPromptOverride(roomId);
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
