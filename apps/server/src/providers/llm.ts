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

/**
 * 流式剥 <think>…</think>（MiniMax M 系把思考混在 content 里且关不掉——不剥则 TTS 念思考过程）。
 * 跨 chunk 边界安全：疑似标签前缀时先扣住不放行，凑齐再判。对无 think 的模型（DeepSeek）零改变。
 */
function createThinkStripper(): (raw: string) => string {
  let buf = '';
  let inThink = false;
  return (raw: string): string => {
    buf += raw;
    let out = '';
    for (;;) {
      if (inThink) {
        const end = buf.indexOf('</think>');
        if (end === -1) {
          // think 内容全吞；留尾部防 '</thi' 跨 chunk 断裂
          buf = buf.slice(Math.max(0, buf.length - 8));
          return out;
        }
        buf = buf.slice(end + '</think>'.length);
        inThink = false;
      }
      const start = buf.indexOf('<think>');
      if (start === -1) {
        // 无完整开标签：若尾部是 '<think>' 的前缀（如 '<thi'）则扣住等下一 chunk
        let hold = 0;
        for (let k = Math.min(7, buf.length); k > 0; k--) {
          if ('<think>'.startsWith(buf.slice(buf.length - k))) {
            hold = k;
            break;
          }
        }
        out += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        return out;
      }
      out += buf.slice(0, start);
      buf = buf.slice(start + '<think>'.length);
      inThink = true;
    }
  };
}

interface LlmEndpoint {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 可选兜底端点（配了即开启双路赛马）：LLM_FALLBACK_BASE_URL / _API_KEY / _MODEL。 */
function fallbackEndpoint(): LlmEndpoint | null {
  const baseUrl = process.env.LLM_FALLBACK_BASE_URL;
  const apiKey = process.env.LLM_FALLBACK_API_KEY;
  const model = process.env.LLM_FALLBACK_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return { name: `fallback:${model}`, baseUrl, apiKey, model };
}

/** 单路流式请求。onFirstVisible 在首个可见(剥think后) token 前调用，返回 false 表示本路已落败应静默丢弃。 */
async function streamOne(
  ep: LlmEndpoint,
  args: LlmStreamArgs,
  controller: AbortController,
  claim: () => boolean,
): Promise<void> {
  const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ep.apiKey}`,
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: ep.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: temperature(),
      max_tokens: maxTokensFor(ep.model),
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
    throw new Error(`LLM 请求失败(${ep.name}) status=${res.status} ${errText.slice(0, 240)}`);
  }
  if (!res.body) throw new Error(`LLM 流响应体为空(${ep.name})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const stripThink = createThinkStripper();
  let buffer = '';
  let full = '';
  let claimed = false;

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
        const visible = stripThink(delta);
        if (!visible) continue;
        if (!claimed) {
          if (!claim()) return; // 另一路已胜出，本路静默退出（对方会 abort 本路）
          claimed = true;
        }
        full += visible;
        args.onDelta(visible);
      } catch {
        /* 忽略噪声 chunk */
      }
    }
  }
  if (claimed) args.onDone(full.trim());
  else if (claim()) args.onDone(full.trim()); // 空回复也算完成（极罕见），避免整轮悬空
}

class OpenAiCompatLlm implements LlmProvider {
  async streamChat(args: LlmStreamArgs): Promise<void> {
    const main: LlmEndpoint = {
      name: `main:${config.llm.model}`,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
    };
    const fb = fallbackEndpoint();
    const started = performance.now();

    // 每路独立 controller；外部 barge-in signal 传播到所有路。
    const racers = (fb ? [main, fb] : [main]).map((ep) => ({ ep, controller: new AbortController() }));
    const abortAll = (): void => racers.forEach((r) => r.controller.abort());
    if (args.signal) {
      if (args.signal.aborted) abortAll();
      else args.signal.addEventListener('abort', abortAll, { once: true });
    }

    // 赛马裁决：首个吐可见 token 的路胜出，其余立即 abort（省 token 也防双播）。
    let winner: string | null = null;
    const claimFor = (mine: { ep: LlmEndpoint; controller: AbortController }) => (): boolean => {
      if (winner !== null) return winner === mine.ep.name;
      winner = mine.ep.name;
      racers.filter((r) => r !== mine).forEach((r) => r.controller.abort());
      if (fb) {
        console.log(`[llm] race won by ${mine.ep.name} ttft=${Math.round(performance.now() - started)}ms`);
      }
      return true;
    };

    const errors: Error[] = [];
    await Promise.all(
      racers.map(async (r) => {
        try {
          await streamOne(r.ep, args, r.controller, claimFor(r));
        } catch (err) {
          if (r.controller.signal.aborted) return; // 被裁决/barge-in 掐掉的不算错
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );
    args.signal?.removeEventListener('abort', abortAll);

    // 全部落败（都失败且无人开腔）才报错；单路失败由另一路兜住。
    if (winner === null && errors.length > 0 && !args.signal?.aborted) {
      args.onError?.(errors[0]!);
    }
  }
}

export function createLlm(): LlmProvider {
  return new OpenAiCompatLlm();
}
