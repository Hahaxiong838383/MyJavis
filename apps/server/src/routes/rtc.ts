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
// @volcengine/openapi 是 CJS，用 require 避免 ESM interop 问题。
const { Signer } = require('@volcengine/openapi') as {
  Signer: new (req: Record<string, unknown>, service: string) => {
    addAuthorization: (cred: { accessKeyId: string; secretKey: string }) => void;
  };
};

const rtcRoute = new Hono();

const RTC_HOST = 'rtc.volcengineapi.com';
const RTC_REGION = 'cn-north-1';
const RTC_VERSION = '2024-12-01';
// 火山 CustomLLM 回调地址：必须公网 HTTPS（火山云回调我方大脑端点）。本地验证可设隧道地址。
const CUSTOM_LLM_URL = process.env.CUSTOM_LLM_URL || 'https://example.com/v1/chat/completions';
const WELCOME = process.env.RTC_WELCOME_MESSAGE || '你好，我在听，有什么可以帮你的？';

/** 拼 custom-llm 回调 URL：?session=roomId（prompt override 键）+ 可选 ?user=（记忆注入键）。 */
function buildCustomLlmUrl(roomId: string, userId?: string): string {
  const params = new URLSearchParams();
  params.set('session', roomId);
  if (userId) params.set('user', userId);
  return `${CUSTOM_LLM_URL}?${params.toString()}`;
}

/** server 端组装 StartVoiceChat 的 VoiceChat 配置（凭证从 env，不下发前端）。 */
function buildVoiceChatConfig(roomId: string, userId: string, memoryUser?: string): Record<string, unknown> {
  return {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: roomId, // 一房一任务（火山要求 TaskId 非空）
    AgentConfig: {
      TargetUserId: [userId],
      WelcomeMessage: WELCOME,
      UserId: 'myjavis_bot', // ★ 必须 ASCII，中文报 invalid UserID
      EnableConversationStateCallback: true,
    },
    Config: {
      ASRConfig: {
        Provider: 'volcano',
        ProviderParams: {
          Mode: 'bigmodel',
          AppId: process.env.VOLC_ASR_APP_ID,
          AccessToken: process.env.VOLC_ASR_ACCESS_TOKEN,
          ApiResourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',
        },
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
        Url: buildCustomLlmUrl(roomId, memoryUser),
        ModelName: 'myjavis',
        APIKey: process.env.CUSTOM_LLM_API_KEY || 'none',
        SystemMessages: [],
      },
      InterruptMode: 0, // 0=可打断（全双工 barge-in）
    },
  };
}

/** 用 AK/SK 签名调火山 RTC OpenAPI（StartVoiceChat / StopVoiceChat）。 */
async function callRtcOpenAPI(action: string, body: Record<string, unknown>): Promise<any> {
  const reqData = {
    region: RTC_REGION,
    method: 'POST',
    params: { Action: action, Version: RTC_VERSION },
    headers: { Host: RTC_HOST, 'Content-Type': 'application/json' },
    body,
  };
  const signer = new Signer(reqData, 'rtc');
  signer.addAuthorization({
    accessKeyId: process.env.VOLC_ACCESS_KEY_ID || '',
    secretKey: process.env.VOLC_SECRET_ACCESS_KEY || '',
  });
  const res = await fetch(`https://${RTC_HOST}?Action=${action}&Version=${RTC_VERSION}`, {
    method: 'POST',
    headers: reqData.headers as Record<string, string>,
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * 起一局实时语音：生成 RTC token + 起 AI agent。
 * body（均可选）：{ systemPrompt?: 调试台实时 prompt; userId?: 记忆注入键 }
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

  const startBody = (await c.req.json().catch(() => ({}))) as { systemPrompt?: string; userId?: string };
  if (startBody.systemPrompt?.trim()) {
    setPromptOverride(roomId, startBody.systemPrompt);
    console.log(`[rtc] prompt override set room=${roomId} (${startBody.systemPrompt.length} 字符)`);
  }
  const memoryUser = startBody.userId?.trim() || undefined;

  // RTC token（订阅 + 发布权限，24h 过期）
  const key = new AccessToken(appId, appKey, roomId, userId);
  key.addPrivilege(privileges.PrivSubscribeStream, 0);
  key.addPrivilege(privileges.PrivPublishStream, 0);
  key.expireTime(Math.floor(Date.now() / 1000) + 24 * 3600);
  const token = key.serialize();

  // 起 AI agent（火山起 task，AI 回调我方 /v1 大脑）
  const result = await callRtcOpenAPI('StartVoiceChat', buildVoiceChatConfig(roomId, userId, memoryUser));
  const err = result?.ResponseMetadata?.Error;
  if (err) {
    console.log(`[rtc] StartVoiceChat failed: ${err.Code} ${err.Message}`);
    return c.json({ ok: false, error: `${err.Code}: ${err.Message}` }, 502);
  }

  console.log(`[rtc] started room=${roomId} user=${userId}`);
  return c.json({ ok: true, appId, roomId, userId, token, taskId: roomId });
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
