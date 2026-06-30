/**
 * 火山 RTC 实时对话「CustomLLM」回调端点（抽取自 P003 routes/custom-llm.ts，剥离小可业务）。
 *
 * 火山 AIGC-RTC Server 把 ASR 转出的文本 + 对话历史，以 **OpenAI ChatCompletion 格式** POST 到此端点，
 * 我们以 **SSE 流**（text/event-stream + data:[DONE]）返回助手回复；火山再把文本送 TTS 播给用户。
 * 即：火山只当「语音 I/O + 编排管道」，**助手的大脑（人设 + 安全 + 记忆注入 + LLM）全留在这里**。
 *
 * 身份/会话映射（抽取自 P003）：
 *  - ?session=roomId → prompt override（调试台实时调 prompt）
 *  - ?user=userId    → 记忆注入键（recall 该用户的记忆）。当前记忆是占位，recall 返回空。
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { assemblePrompt } from '../prompt/orchestrator.js';
import { createLlm } from '../providers/llm.js';
import { getPromptOverride } from '../rtc-prompt-override.js';
import { memory } from '../memory/index.js';
import type { ChatTurn } from '../providers/types.js';

const customLlmRoute = new Hono();

type OpenAiMessage = { role: string; content: unknown };

/** OpenAI content 可能是 string 或 content-parts 数组；火山 ASR 出的是纯文本，兜底两种形态。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return content == null ? '' : String(content);
}

customLlmRoute.post('/chat/completions', async (c) => {
  // 可选鉴权：配了 CUSTOM_LLM_API_KEY 就校验 Bearer（须与火山 CustomLLM.APIKey 一致）；未配则放行（本地验证方便）。
  const requiredKey = process.env.CUSTOM_LLM_API_KEY?.trim();
  if (requiredKey) {
    const auth = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m || m[1]?.trim() !== requiredKey) {
      return c.json({ error: { message: 'unauthorized', type: 'invalid_request_error' } }, 401);
    }
  }

  let body: { messages?: OpenAiMessage[]; model?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: { message: 'invalid json body' } }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const chat = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastUserIdx = chat.map((m) => m.role).lastIndexOf('user');
  const userText = lastUserIdx >= 0 ? extractText(chat[lastUserIdx]!.content) : '';
  const history: ChatTurn[] = chat
    .slice(0, Math.max(lastUserIdx, 0))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: extractText(m.content) }));

  const sessionId = c.req.query('session') ?? undefined; // roomId → prompt override 键
  const userId = c.req.query('user') ?? undefined; // 记忆注入键

  // override（调试台实时调的 prompt）优先：直接用它（自带完整内容）；否则走默认人设组装 + 记忆注入。
  const overridePrompt = getPromptOverride(sessionId);
  const memories =
    !overridePrompt && userId ? await memory.recall({ userId, userText, limit: 8 }).catch(() => []) : [];
  const systemPrompt = overridePrompt ?? assemblePrompt({ memories });

  console.log(
    `[custom-llm] session=${sessionId ?? '-'} user=${userId ?? '-'}` +
      `${overridePrompt ? ' [override]' : ''}${memories.length ? ` [mem:${memories.length}]` : ''}`,
  );

  // 对话落记忆（异步、不阻塞回应）；当前记忆占位 → no-op。
  if (userId && userText.trim()) {
    void memory.extractAndWrite(userId, [...history, { role: 'user', content: userText }]).catch(() => {});
  }

  const llm = createLlm();
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'myjavis';

  return streamSSE(c, async (stream) => {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

    // 串行写出，保证 SSE chunk 顺序（writeSSE 是 async，并发写会乱序）。
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = (data: string): void => {
      chain = chain.then(() => stream.writeSSE({ data }));
    };

    enqueue(chunk({ role: 'assistant', content: '' }, null)); // OpenAI 规范：首 chunk 带 role
    try {
      await llm.streamChat({
        systemPrompt,
        userText,
        history,
        onDelta: (delta) => enqueue(chunk({ content: delta }, null)),
        onDone: () => enqueue(chunk({}, 'stop')),
        onError: (err) => enqueue(chunk({ content: `（助手出错了：${err.message}）` }, 'stop')),
      });
    } catch (err) {
      enqueue(chunk({ content: `（助手暂时连不上大脑：${(err as Error)?.message ?? err}）` }, 'stop'));
    }
    enqueue('[DONE]'); // 火山要求的终止符
    await chain;
  });
});

export { customLlmRoute };
