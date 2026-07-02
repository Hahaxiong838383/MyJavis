/**
 * LLM Provider —— OpenAI 兼容流式实现（抽取自 P003 gemini-llm.ts，去掉小可默认人设）。
 *
 * 配置走 config.llm（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），任何 OpenAI 兼容端点可插：
 * Gemini 代理网关 / DeepSeek / MiniMax / vLLM 自托管 等。
 *
 * RTC CustomLLM 路径要求服务端「OpenAI 兼容」——本 provider 既被 custom-llm 路由复用，
 * 也可被 WS pipeline 复用，保证两条入口同一个大脑、不漂移。
 */

import { config } from '../config.js';
import type { LlmProvider, LlmStreamArgs } from './types.js';

/**
 * 各模型 max_tokens 上限（实测，抽取自 P003）：
 * - gemini-2.5-pro: 32768
 * - gemini-2.5-flash / 2.5-flash-lite / 3.x: 65535
 * - minimax: 8192
 * - 其余: 8192（保守）
 */
function maxTokensFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('minimax')) return 8192;
  if (m.includes('gemini-2.5-pro')) return 32768;
  if (m.startsWith('gemini-2.5') || m.startsWith('gemini-3')) return 65535;
  return 8192;
}

/** 采样温度旋钮：默认 1.0（避免「提前录制感」）；LLM_TEMPERATURE 可调，非法回退 1.0。 */
function temperature(): number {
  const raw = process.env.LLM_TEMPERATURE;
  if (raw === undefined || raw.trim() === '') return 1.0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1.0;
}

/**
 * 关闭端点侧 reasoning（DeepSeek v4 实测 TTFT 减半：2.4s→~1s；kidshub 同款验证 2.7s→1.1s）。
 * 语音链路只消费 delta.content，reasoning 段纯拖开口延迟。默认开；端点不认此字段时
 * LLM_DISABLE_THINKING=0 关闭（DeepSeek 生效 / MiniMax 接受但忽略，均不报错）。
 */
function thinkingDisabled(): boolean {
  return (process.env.LLM_DISABLE_THINKING ?? '1') !== '0';
}

class OpenAiCompatLlm implements LlmProvider {
  async streamChat(args: LlmStreamArgs): Promise<void> {
    const { baseUrl, apiKey, model } = config.llm;

    // 外部传入的 signal（barge-in 中断）优先；否则本地建一个用于清理。
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (args.signal) {
      if (args.signal.aborted) controller.abort();
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          temperature: temperature(),
          max_tokens: maxTokensFor(model),
          ...(thinkingDisabled() ? { thinking: { type: 'disabled' } } : {}),
          messages: [
            { role: 'system', content: args.systemPrompt },
            ...args.history,
            { role: 'user', content: args.userText },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`LLM 请求失败 status=${res.status} ${errText.slice(0, 240)}`);
      }
      if (!res.body) throw new Error('LLM 流响应体为空');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const chunk = line.slice(5).trim();
          if (!chunk || chunk === '[DONE]') continue;
          try {
            const evt = JSON.parse(chunk) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = evt.choices?.[0]?.delta?.content;
            if (!delta) continue;
            full += delta;
            args.onDelta(delta);
          } catch {
            /* 忽略噪声 chunk */
          }
        }
      }

      args.onDone(full.trim());
    } catch (err) {
      if (controller.signal.aborted) return; // 主动中断不算错误（barge-in）
      args.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      args.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function createLlm(): LlmProvider {
  return new OpenAiCompatLlm();
}
