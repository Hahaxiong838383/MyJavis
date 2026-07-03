/**
 * MyJavis server 入口 —— Hono + Node 22 ESM。
 *
 * 当前接通「火山 RTC 路径」（可跑骨架）：
 *   - GET  /health                  健康检查
 *   - POST /api/rtc/start|stop|update-prompt   火山 RTC 房间/token/prompt 热更
 *   - POST /v1/chat/completions     火山 AIGC-RTC CustomLLM 回调（OpenAI 兼容 SSE）= 助手大脑
 *
 * WS 路径（/ws/voice，服务端跑 ASR/LLM/TTS 三段）尚为 provider 骨架（volc-asr/volc-tts 待补二进制帧），
 * pipeline.ts 未接线 —— 见 docs/ARCHITECTURE.md。记忆系统当前为占位（NullMemoryStore）。
 */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rtcRoute } from './routes/rtc.js';
import { customLlmRoute } from './routes/custom-llm.js';
import { governanceRoute } from './routes/governance.js';
import { voiceprintRoute } from './routes/voiceprint.js';

// 版本真源 package.json（dist 运行时向上一级找；与 App 版本同步 bump）
const VERSION = ((): string => {
  for (const p of [new URL('../package.json', import.meta.url), new URL('./package.json', import.meta.url)]) {
    try {
      return (JSON.parse(readFileSync(p, 'utf-8')) as { version: string }).version;
    } catch {
      /* try next */
    }
  }
  return 'unknown';
})();

const app = new Hono();
const port = Number(process.env.PORT ?? 3001);

// CORS 放开 origin（Tauri tauri://localhost / 本地 dev 各端都要来）；CORS 不是安全边界，真防线是下方 key。
app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'X-Javis-Key', 'Authorization'] }));

// /api/* 鉴权：JAVIS_API_KEY 设了才校验（本地 dev 不设不拦）；/v1 有自己的 CUSTOM_LLM_API_KEY 门。
app.use('/api/*', async (c, next) => {
  const required = process.env.JAVIS_API_KEY;
  if (required && c.req.header('x-javis-key') !== required) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  await next();
});

app.get('/health', (c) => c.json({ status: 'ok', service: 'myjavis-server', version: VERSION }));
app.route('/api/rtc', rtcRoute);
app.route('/api/governance', governanceRoute);
app.route('/api/voiceprint', voiceprintRoute);
// 火山 RTC 实时对话 CustomLLM 回调端点：OpenAI 兼容 /v1/chat/completions（SSE）。
app.route('/v1', customLlmRoute);

serve(
  {
    fetch: app.fetch,
    port,
    // 显式 IPv4：node22 下默认监听 '::' 在 macOS 上不接受 127.0.0.1（vite proxy 会 refused）。
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`[server] myjavis listening on http://${info.address}:${info.port}`);
    logProviderStatus();
  },
);

function logProviderStatus(): void {
  const rtcOk = Boolean(
    process.env.VOLC_RTC_APP_ID &&
      process.env.VOLC_RTC_APP_KEY &&
      process.env.VOLC_ACCESS_KEY_ID &&
      process.env.VOLC_SECRET_ACCESS_KEY,
  );
  const ttsOk = Boolean(process.env.VOLC_TTS_APP_ID && process.env.VOLC_TTS_ACCESS_TOKEN);
  const asrOk = Boolean(process.env.VOLC_ASR_APP_ID && process.env.VOLC_ASR_ACCESS_TOKEN);
  const llmOk = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);
  console.log(`[server] RTC(OpenAPI): ${rtcOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] ASR: ${asrOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] TTS: ${ttsOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] LLM: ${llmOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] memory: SQLiteMemoryStore + governance`);
}
