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
import { tenantRoute, meRoute } from './routes/tenant.js';
import { findTenantByToken } from './tenant/registry.js';
import type { AppEnv } from './tenant/context.js';
import { musicRoute } from './routes/music.js';
import { remindersRoute } from './routes/reminders.js';
import { syncRoute } from './routes/sync.js';
import { privacyRoute } from './routes/privacy.js';
import { startReminderScheduler } from './reminder/scheduler.js';
import { MemoryRefiner } from './memory/refine.js';
import { storage as memoryStorage } from './memory/index.js';
import { tenantForOwner } from './voiceprint/registry.js';

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

const app = new Hono<AppEnv>();
const port = Number(process.env.PORT ?? 3001);

// CORS 放开 origin（Tauri tauri://localhost / 本地 dev 各端都要来）；CORS 不是安全边界，真防线是下方 key。
app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'X-Javis-Key', 'Authorization'] }));

// /api/* 鉴权（多租户，批次A）：X-Javis-Key = 租户邀请码 → 绑定租户；= JAVIS_API_KEY → admin。
// JAVIS_API_KEY 未设时（本地 dev）不拦且视为 admin。/v1 有自己的 CUSTOM_LLM_API_KEY 门。
app.use('/api/*', async (c, next) => {
  const key = c.req.header('x-javis-key') ?? '';
  const adminKey = process.env.JAVIS_API_KEY;
  if (!adminKey || key === adminKey) {
    c.set('tenant', null);
    c.set('isAdmin', true);
    await next();
    return;
  }
  const tenant = key ? findTenantByToken(key) : undefined;
  if (!tenant) return c.json({ ok: false, error: 'unauthorized' }, 401);
  c.set('tenant', tenant);
  c.set('isAdmin', false);
  await next();
});

app.get('/health', (c) => c.json({ status: 'ok', service: 'myjavis-server', version: VERSION }));
app.route('/api/rtc', rtcRoute);
app.route('/api/governance', governanceRoute);
app.route('/api/voiceprint', voiceprintRoute);
app.route('/api/tenant', tenantRoute); // admin only（租户 CRUD/发码）
app.route('/api/me', meRoute); // 租户自查/自配（激活校验+persona/称呼）
app.route('/api/music', musicRoute);
app.route('/api/reminders', remindersRoute);
app.route('/api/sync', syncRoute);
app.route('/api/privacy', privacyRoute); // R2 隐私记忆通道（pending/ack/session-context）
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
    startReminderScheduler();
    new MemoryRefiner(memoryStorage, undefined, tenantForOwner).start(); // R3 批处理精修
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
