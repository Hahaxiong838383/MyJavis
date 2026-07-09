/**
 * Gate 1 探测脚本（一次性，非 CI 测试）：真实调用 DeepSeek(main) + MiniMax(fallback)，
 * 验证流式 function calling 是否可靠（语法正确 + 撞词不误调 + 真指令正确调）。
 * 输出：控制台摘要 + docs/gate1-probe-evidence.md（原始请求/响应片段留档）。
 *
 * 跑法：cd apps/server && tsx --env-file=../../.env scripts/gate1-probe.ts
 */
import { writeFileSync } from 'node:fs';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'music_control',
      description:
        "控制正在播放的音乐。仅当用户明确想操作音乐播放时调用；聊天中提到相关字眼（如'换一个话题''停一下我想想'）不要调用。",
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'next', 'prev', 'louder', 'quieter'],
            description: 'pause=暂停 resume=继续播 next=换一首/下一首 prev=上一首 louder=大声点 quieter=小声点',
          },
        },
        required: ['action'],
      },
    },
  },
];

const SYSTEM_PROMPT = '你是一个语音助手，正常聊天。';
const CONTEXT_NOTE =
  '[系统状态] 当前房间正在播放音乐：《夜曲》。用户若想暂停/继续/换歌/调音量，调用 music_control；普通聊天正常回复，别把聊天字眼当指令。';

type Case = { text: string; expect: 'no-call' | string; group: 'collision' | 'command' | 'semantic' };

const CASES: Case[] = [
  // 撞词反例（期望 no-call）—— 挑历史真机踩坑最凶的
  { text: '我们换一个话题', expect: 'no-call', group: 'collision' },
  { text: '停一下我想想', expect: 'no-call', group: 'collision' },
  { text: '你说话大声一点', expect: 'no-call', group: 'collision' },
  { text: '上一个问题你还没答', expect: 'no-call', group: 'collision' },
  { text: '继续说啊', expect: 'no-call', group: 'collision' },
  { text: '别停，我听着呢', expect: 'no-call', group: 'collision' },
  // 真指令（期望正确 action）—— 覆盖全部 6 动作
  { text: '暂停', expect: 'pause', group: 'command' },
  { text: '停止播放', expect: 'pause', group: 'command' },
  { text: '换一首', expect: 'next', group: 'command' },
  { text: '上一首', expect: 'prev', group: 'command' },
  { text: '继续播', expect: 'resume', group: 'command' },
  { text: '大声点', expect: 'louder', group: 'command' },
  // 语义增强（不设硬门槛，仅记录表现，Gate2 正式测）
  { text: '这歌太吵了', expect: 'no-call(建议性)', group: 'semantic' },
  { text: '换个安静点的', expect: 'no-call(建议性)', group: 'semantic' },
];

interface Endpoint {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

const MAIN: Endpoint = {
  label: 'DeepSeek(main)',
  baseUrl: requireEnv('LLM_BASE_URL'),
  apiKey: requireEnv('LLM_API_KEY'),
  model: requireEnv('LLM_MODEL'),
};
const FALLBACK: Endpoint = {
  label: 'MiniMax(fallback)',
  baseUrl: requireEnv('LLM_FALLBACK_BASE_URL'),
  apiKey: requireEnv('LLM_FALLBACK_API_KEY'),
  model: requireEnv('LLM_FALLBACK_MODEL'),
};

interface ToolCallBuf {
  id?: string;
  name?: string;
  args: string;
}

interface ProbeResult {
  case: Case;
  ok: boolean; // 请求本身是否成功（HTTP 200 + 流可解析）
  httpStatus?: number;
  errText?: string;
  contentFirstChunkMs?: number;
  toolCallFirstChunkMs?: number;
  finishReason?: string | null;
  toolCalls: ToolCallBuf[];
  contentText: string;
  rawLines: string[]; // 原始 SSE data 行（留档用，截断）
  judged: 'PASS' | 'FAIL' | 'INFO';
  judgeNote: string;
}

async function probeOne(ep: Endpoint, c: Case): Promise<ProbeResult> {
  const started = performance.now();
  const body = {
    model: ep.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 1.0,
    max_tokens: 512,
    thinking: { type: 'disabled' },
    tools: TOOLS,
    tool_choice: 'auto',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: CONTEXT_NOTE },
      { role: 'user', content: c.text },
    ],
  };

  let res: Response;
  try {
    res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      case: c,
      ok: false,
      errText: `fetch 异常: ${(err as Error).message}`,
      toolCalls: [],
      contentText: '',
      rawLines: [],
      judged: 'FAIL',
      judgeNote: '请求本身失败',
      finishReason: null,
    };
  }

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    return {
      case: c,
      ok: false,
      httpStatus: res.status,
      errText: errText.slice(0, 500),
      toolCalls: [],
      contentText: '',
      rawLines: [],
      judged: 'FAIL',
      judgeNote: `HTTP ${res.status}`,
      finishReason: null,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentText = '';
  let contentFirstChunkMs: number | undefined;
  let toolCallFirstChunkMs: number | undefined;
  let finishReason: string | null = null;
  const toolBufs = new Map<number, ToolCallBuf>();
  const rawLines: string[] = [];

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
      if (!chunk) continue;
      if (rawLines.length < 40) rawLines.push(chunk);
      if (chunk === '[DONE]') continue;
      try {
        const evt = JSON.parse(chunk) as {
          choices?: Array<{
            delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
            finish_reason?: string | null;
          }>;
        };
        const choice = evt.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) {
          if (contentFirstChunkMs === undefined) contentFirstChunkMs = performance.now() - started;
          contentText += delta.content;
        }
        if (delta?.tool_calls) {
          if (toolCallFirstChunkMs === undefined) toolCallFirstChunkMs = performance.now() - started;
          for (const tc of delta.tool_calls) {
            const buf = toolBufs.get(tc.index) ?? { args: '' };
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.args += tc.function.arguments;
            toolBufs.set(tc.index, buf);
          }
        }
      } catch {
        /* 噪声 chunk 忽略 */
      }
    }
  }

  const toolCalls = [...toolBufs.values()];
  let judged: 'PASS' | 'FAIL' | 'INFO' = 'INFO';
  let judgeNote = '';
  if (c.group === 'collision') {
    judged = toolCalls.length === 0 ? 'PASS' : 'FAIL';
    judgeNote = toolCalls.length === 0 ? '未误调用' : `误调用: ${toolCalls.map((t) => `${t.name}(${t.args})`).join(',')}`;
  } else if (c.group === 'command') {
    const parsed = toolCalls[0]?.args ? safeParseAction(toolCalls[0].args) : undefined;
    judged = toolCalls.length === 1 && parsed === c.expect ? 'PASS' : 'FAIL';
    judgeNote =
      toolCalls.length === 0
        ? '未调用工具（漏调）'
        : toolCalls.length > 1
          ? `调用了${toolCalls.length}次工具（异常）`
          : parsed === c.expect
            ? `正确 action=${parsed}`
            : `action 不符：期望${c.expect} 实际${parsed ?? toolCalls[0]?.args}`;
  } else {
    judged = 'INFO';
    judgeNote = toolCalls.length ? `调用了 ${toolCalls.map((t) => `${t.name}(${t.args})`).join(',')}` : `纯聊天: "${contentText.slice(0, 60)}"`;
  }

  return {
    case: c,
    ok: true,
    contentFirstChunkMs: contentFirstChunkMs ? Math.round(contentFirstChunkMs) : undefined,
    toolCallFirstChunkMs: toolCallFirstChunkMs ? Math.round(toolCallFirstChunkMs) : undefined,
    finishReason,
    toolCalls,
    contentText,
    rawLines,
    judged,
    judgeNote,
  };
}

function safeParseAction(argsJson: string): string | undefined {
  try {
    const o = JSON.parse(argsJson) as { action?: string };
    return o.action;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const endpoints = [MAIN, FALLBACK];
  const allResults: { ep: Endpoint; results: ProbeResult[] }[] = [];

  for (const ep of endpoints) {
    console.log(`\n=== ${ep.label} (${ep.model}) ===`);
    const results: ProbeResult[] = [];
    for (const c of CASES) {
      const r = await probeOne(ep, c);
      results.push(r);
      const status = r.ok ? `${r.judged}` : `ERROR(${r.errText ?? r.httpStatus})`;
      console.log(
        `[${c.group}] "${c.text}" → ${status} ${r.judgeNote ?? ''} (content_ms=${r.contentFirstChunkMs ?? '-'} tool_ms=${r.toolCallFirstChunkMs ?? '-'})`,
      );
    }
    allResults.push({ ep, results });
  }

  // 可靠性判定：collision + command 两组全 PASS 才算「可靠」（≥5条/家，本探测各6条）
  console.log('\n=== 可靠性汇总 ===');
  const reliability = allResults.map(({ ep, results }) => {
    const graded = results.filter((r) => r.case.group !== 'semantic');
    const passed = graded.filter((r) => r.judged === 'PASS').length;
    const reliable = passed === graded.length;
    console.log(`${ep.label}: ${passed}/${graded.length} PASS → ${reliable ? '可靠 ✅' : '不可靠 ❌'}`);
    return { ep: ep.label, model: ep.model, passed, total: graded.length, reliable };
  });

  // 留档：原始请求/响应片段
  const evidence = renderEvidence(allResults, reliability);
  const outPath = new URL('../../../docs/gate1-probe-evidence.md', import.meta.url);
  writeFileSync(outPath, evidence, 'utf-8');
  console.log(`\n证据文件已写入: ${outPath.pathname}`);
}

function renderEvidence(
  allResults: { ep: Endpoint; results: ProbeResult[] }[],
  reliability: { ep: string; model: string; passed: number; total: number; reliable: boolean }[],
): string {
  const lines: string[] = [];
  lines.push('# Gate 1 探测证据（DeepSeek + MiniMax 流式 Function Calling）');
  lines.push('');
  lines.push(`探测时间：脚本运行时生成 · 工具定义见 §4.2 · 每家 ${CASES.length} 条样本（撞词6+指令6+语义2）`);
  lines.push('');
  lines.push('## 可靠性汇总');
  lines.push('');
  lines.push('| Provider | Model | 撞词+指令通过 | 判定 |');
  lines.push('|---|---|---|---|');
  for (const r of reliability) {
    lines.push(`| ${r.ep} | ${r.model} | ${r.passed}/${r.total} | ${r.reliable ? '✅ 可靠' : '❌ 不可靠'} |`);
  }
  lines.push('');

  for (const { ep, results } of allResults) {
    lines.push(`## ${ep.label} (${ep.model})`);
    lines.push('');
    for (const r of results) {
      lines.push(`### [${r.case.group}] "${r.case.text}"（期望：${r.case.expect}）`);
      lines.push('');
      lines.push(`- 判定：**${r.judged}** — ${r.judgeNote}`);
      lines.push(`- finish_reason: \`${r.finishReason}\` · content 首块: ${r.contentFirstChunkMs ?? '-'}ms · tool_call 首块: ${r.toolCallFirstChunkMs ?? '-'}ms`);
      if (r.contentText) lines.push(`- content 文本: "${r.contentText.slice(0, 100)}"`);
      if (!r.ok) lines.push(`- 错误: ${r.errText ?? r.httpStatus}`);
      lines.push('- 原始 SSE 片段（截断前 12 行）：');
      lines.push('```');
      for (const l of r.rawLines.slice(0, 12)) lines.push(l.slice(0, 300));
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('探测脚本异常:', err);
  process.exit(1);
});
