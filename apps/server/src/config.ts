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

  vision: {
    /** Vision 感知 V0（2026-07-14，默认关）：开=接受 /api/perception/ingest 上报并向
     *  LLM 注入 visionContextNote。关=端点 503 且零注入。见 docs/VISION-评估与V0方案.md。 */
    enabled: opt('VISION_ENABLED', '0') === '1',
    /** ②走开/回来主动打招呼（VISION_ENABLED 前提下生效；出现骚扰感可单独关）。 */
    greetingEnabled: opt('VISION_GREETING_ENABLED', '1') === '1',
    /** 切片3 look_closely 按需细看（用户主动问→单帧上云 VLM；kill switch）。 */
    lookEnabled: opt('VISION_LOOK_ENABLED', '1') === '1',
  },

  memoryConsolidation: {
    /** R4 夜间异步巩固（默认开）：ephemeral 清理 + dormant 冷藏 + 对账 + profile 重算兜底。
     *  见 docs/memory-architecture.md §5.2/§6 R4，实现 apps/server/src/memory/consolidation.ts。 */
    enabled: opt('CONSOLIDATION_ENABLED', '1') === '1',
    /** 本地时区跑批的目标整点（0-23，默认凌晨 4 点）。 */
    hour: Number(opt('CONSOLIDATION_HOUR', '4')),
  },

  memoryRefineProxy: {
    /** R4 提炼代理端点 POST /api/memory/refine（默认开）：App vault 批次 → server 转发
     *  LLM → 结构化 ADD/UPDATE/DELETE/NONE 决策，全程内存零落盘。关=端点 503。
     *  见 docs/memory-architecture.md §4.4，实现 apps/server/src/routes/memory-refine.ts。 */
    enabled: opt('MEMORY_REFINE_PROXY_ENABLED', '1') === '1',
  },
} as const;
