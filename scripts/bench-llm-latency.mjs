#!/usr/bin/env node
/**
 * LLM 延时基准（可开口 TTFT）—— MyJavis 选型 / 换 provider 复用工具
 *
 * 任何 OpenAI 兼容流式端点都能测。核心指标 ttft_speakable = 剥 <think> +
 * 忽略 reasoning_content 后「首个可送 TTS 的字符」时刻，语音场景唯一真指标：
 * raw TTFT 会被 think 段骗（首 chunk 常是 <think> 开头，念不了）。判定逻辑
 * 与生产 apps/server/src/providers/llm.ts 的 createThinkStripper 对齐。
 *
 * 用法:  ARK_KEY=<key> node scripts/bench-llm-latency.mjs <baseUrl> <model> [rounds=3]
 * 例:    ARK_KEY=$ARK_CODING_API_KEY node scripts/bench-llm-latency.mjs \
 *          https://ark.cn-beijing.volces.com/api/coding/v3 doubao-seed-2.0-lite 3
 *
 * key 只从环境变量 ARK_KEY 取、baseUrl / model 从 argv —— 脚本本身无任何密钥，可进仓。
 * SYSTEM / QUESTIONS 贴 MyJavis 真实语音负载（人设 system + 短问），换项目改这两处即可。
 *
 * 2026-07-06 火山方舟 Coding 端点实测（生产机 47.239 HK→北京，各 3 轮中位 speakable TTFT）：
 *   doubao-seed-2.0-lite 464ms · deepseek-v4-flash 1348ms ·
 *   doubao-seed-2.0-pro 1659ms · glm-5.2 2119ms
 * 结论：pro 不降智但比现有 DeepSeek 直连还慢（排除）；只有 lite 有速度价值（464ms，代价=降 lite 档）。
 */

const [baseUrl, model, roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg || 3);
const apiKey = process.env.ARK_KEY;
if (!baseUrl || !model || !apiKey) {
  console.error('用法: ARK_KEY=xxx node scripts/bench-llm-latency.mjs <baseUrl> <model> [rounds]');
  process.exit(1);
}

// 贴近 MyJavis 真实负载：几百字人设 system + 语音短问
const SYSTEM = `你是 Javis，一个私人语音助手。性格沉稳可靠、说话简洁自然，像一位靠谱的老朋友。
规范：
1. 输出将直接送 TTS 朗读，禁止任何 Markdown 符号、括号旁白、emoji、列表编号。
2. 回答口语化、短句优先，一般不超过三句话；复杂问题先给结论再补一句解释。
3. 用户可能在做饭、开车等场景，回答要一听就懂，不要求用户看屏幕。
4. 不确定的事实明说不确定，不编造。涉及健康、法律、金钱的重要决定，提醒用户咨询专业人士。
5. 中文回答。语气自然，不要客服腔，不要每句都带称呼。
当前场景：用户通过实时语音与你对话，你的回答会被逐句合成为语音播放。`;

const QUESTIONS = [
  '今天适合跑步吗？',
  '帮我想个周末晚餐吃什么。',
  '用一句话解释什么是复利。',
];

// 与生产 createThinkStripper 同款：流式剥 <think>…</think>
function createThinkStripper() {
  let buf = '';
  let inThink = false;
  return (raw) => {
    buf += raw;
    let out = '';
    for (;;) {
      if (inThink) {
        const end = buf.indexOf('</think>');
        if (end === -1) { buf = buf.slice(Math.max(0, buf.length - 8)); return out; }
        buf = buf.slice(end + 8);
        inThink = false;
      }
      const start = buf.indexOf('<think>');
      if (start === -1) {
        let hold = 0;
        for (let k = Math.min(7, buf.length); k > 0; k--) {
          if ('<think>'.startsWith(buf.slice(buf.length - k))) { hold = k; break; }
        }
        out += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        return out;
      }
      out += buf.slice(0, start);
      buf = buf.slice(start + 7);
      inThink = true;
    }
  };
}

async function runOnce(question, withThinkingDisabled) {
  const t0 = performance.now();
  const body = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 1.0,
    max_tokens: 1024,
    ...(withThinkingDisabled ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: question },
    ],
  };
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const ttfb = performance.now() - t0;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { error: `status=${res.status} ${errText.slice(0, 300)}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const stripThink = createThinkStripper();
  let buffer = '';
  let ttftRaw = null;
  let ttftSpeakable = null;
  let contentChars = 0;
  let reasoningChars = 0;
  let firstVisible = '';

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
      let evt;
      try { evt = JSON.parse(chunk); } catch { continue; }
      const delta = evt.choices?.[0]?.delta;
      if (!delta) continue;
      const rc = delta.reasoning_content || '';
      const c = delta.content || '';
      if ((rc || c) && ttftRaw === null) ttftRaw = performance.now() - t0;
      reasoningChars += rc.length;
      if (c) {
        const visible = stripThink(c);
        contentChars += c.length;
        if (visible && ttftSpeakable === null) {
          ttftSpeakable = performance.now() - t0;
          firstVisible = visible.slice(0, 20);
        }
      }
    }
  }
  const total = performance.now() - t0;
  return {
    ttfb: Math.round(ttfb),
    ttft_raw: ttftRaw === null ? null : Math.round(ttftRaw),
    ttft_speakable: ttftSpeakable === null ? null : Math.round(ttftSpeakable),
    total: Math.round(total),
    contentChars,
    reasoningChars,
    firstVisible: firstVisible.replace(/\n/g, ' '),
  };
}

const results = [];
let thinkingDisabledOk = true;
for (let i = 0; i < rounds; i++) {
  const q = QUESTIONS[i % QUESTIONS.length];
  let r = await runOnce(q, thinkingDisabledOk);
  // 端点不认 thinking 字段 → 去掉重试并标注
  if (r.error && /thinking|invalid|parameter/i.test(r.error) && thinkingDisabledOk) {
    console.error(`  [!] ${model} 不认 thinking 字段，改用默认形态重试: ${r.error.slice(0, 120)}`);
    thinkingDisabledOk = false;
    r = await runOnce(q, false);
  }
  if (r.error) {
    console.error(`  [x] round${i + 1} ${r.error}`);
    results.push(null);
  } else {
    console.error(
      `  round${i + 1} ttfb=${r.ttfb} raw=${r.ttft_raw} speakable=${r.ttft_speakable} total=${r.total} ` +
      `content=${r.contentChars}字 reasoning=${r.reasoningChars}字 首句「${r.firstVisible}」`,
    );
    results.push(r);
  }
  await new Promise((s) => setTimeout(s, 1000));
}

const ok = results.filter(Boolean);
if (ok.length === 0) { console.log(JSON.stringify({ model, error: 'all rounds failed' })); process.exit(2); }
const med = (key) => {
  const v = ok.map((r) => r[key]).filter((x) => x !== null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
console.log(JSON.stringify({
  model,
  thinkingDisabledAccepted: thinkingDisabledOk,
  rounds: ok.length,
  median: { ttfb: med('ttfb'), ttft_raw: med('ttft_raw'), ttft_speakable: med('ttft_speakable'), total: med('total') },
  avgReasoningChars: Math.round(ok.reduce((s, r) => s + r.reasoningChars, 0) / ok.length),
  avgContentChars: Math.round(ok.reduce((s, r) => s + r.contentChars, 0) / ok.length),
}));
