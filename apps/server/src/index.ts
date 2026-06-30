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
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { rtcRoute } from './routes/rtc.js';
import { customLlmRoute } from './routes/custom-llm.js';

const app = new Hono();
const port = Number(process.env.PORT ?? 3001);

app.get('/health', (c) => c.json({ status: 'ok', service: 'myjavis-server' }));
app.route('/api/rtc', rtcRoute);
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
  console.log(`[server] memory: NullMemoryStore (占位，待产品定义)`);
}
