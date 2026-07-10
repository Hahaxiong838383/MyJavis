/**
 * 集中读取环境变量。缺失时 fail fast（系统边界校验，见 behavior.md 工程红线）。
 * 抽取自 P003，但凭证 key 名通用化。
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[config] 缺少必需环境变量: ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(opt('PORT', '3001')),
  authJwtSecret: process.env.AUTH_JWT_SECRET ?? '',

  rtc: {
    get appId() {
      return req('VOLC_RTC_APP_ID');
    },
    get appKey() {
      return req('VOLC_RTC_APP_KEY');
    },
  },

  asr: {
    get appId() {
      return req('VOLC_ASR_APP_ID');
    },
    get accessToken() {
      return req('VOLC_ASR_ACCESS_TOKEN');
    },
    endpoint: opt('VOLC_ASR_ENDPOINT', 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'),
    resourceId: opt('VOLC_ASR_RESOURCE_ID', 'volc.bigasr.sauc.duration'),
  },

  tts: {
    get appId() {
      return req('VOLC_TTS_APP_ID');
    },
    get accessToken() {
      return req('VOLC_TTS_ACCESS_TOKEN');
    },
    endpoint: opt('VOLC_TTS_ENDPOINT', 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'),
    voice: opt('VOLC_TTS_VOICE', 'zh_female_tianmeixiaoyuan_moon_bigtts'),
  },

  llm: {
    get baseUrl() {
      return req('LLM_BASE_URL');
    },
    get apiKey() {
      return req('LLM_API_KEY');
    },
    get model() {
      return req('LLM_MODEL');
    },
  },

  music: {
    baseUrl: opt('MUSIC_ORCHESTRATOR_URL', ''),
    apiKey: opt('MUSIC_ORCHESTRATOR_KEY', ''),
    streamPublicBase: opt('MUSIC_STREAM_PUBLIC_BASE', ''),
    enabled: Boolean(opt('MUSIC_ORCHESTRATOR_URL', '')),
    /** 音乐控制意图 function calling（2026-07-09 灰度转正：默认开）。开关保留为运维
     *  kill switch——DeepSeek 大面积故障期可设 0 秒回正则版。见 docs/IMPL-音乐意图AI化-PROMPT.md。 */
    fcEnabled: opt('MUSIC_FC_ENABLED', '1') === '1',
  },
} as const;
