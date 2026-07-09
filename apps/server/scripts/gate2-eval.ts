/**
 * Gate 2 数据脚本（一次性，非 CI 测试）：真实 /v1 HTTP + 真 provider 跑 §5.1 意图测试集。
 * 前置：本地起 server（PORT=3390，MUSIC_FC_ENABLED=1 + MUSIC_ORCHESTRATOR_URL/STUB 已配，
 * 建议 FILLER_ENABLED=0 避免承接句掩盖真实 speakable_ms），stdout 重定向到一个日志文件
 * （本脚本靠 grep 该日志的 [music-fc] 行拿「是否调用工具/实际action」ground truth —— 这信息
 * 不会出现在 SSE 响应里，这正是设计要的：tool_call 100% 拦在 TTS 之外）。
 *
 * 跑法：tsx scripts/gate2-eval.ts <baseUrl> <serverLogPath> [--fc-off]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:3390';
const SERVER_LOG_PATH = process.argv[3];
const FC_OFF = process.argv.includes('--fc-off');
const API_KEY = process.env.CUSTOM_LLM_API_KEY ?? '';

if (!SERVER_LOG_PATH) {
  console.error('用法: tsx scripts/gate2-eval.ts <baseUrl> <serverLogPath> [--fc-off]');
  process.exit(1);
}

type Group = 'collision' | 'command' | 'semantic';
interface Case {
  text: string;
  expect: string;
  group: Group;
}

// §5.1 原文清单（一字不改）
const COLLISION_CASES: Case[] = [
  '我们换一个话题',
  '停一下我想想',
  '你说话大声一点',
  '上一个问题你还没答',
  '继续说啊',
  '别停，我听着呢',
  '把灯关了',
  '这个方案先暂停推进',
  '换个说法',
  '声音这个词怎么写',
].map((text) => ({ text, expect: 'no-call', group: 'collision' as const }));

const COMMAND_EXPECT: Record<string, string> = {
  暂停: 'pause',
  停止播放: 'pause',
  别放了: 'pause',
  换一首: 'next',
  下一首: 'next',
  切歌: 'next',
  继续播: 'resume',
  接着放: 'resume',
  大声点: 'louder',
  小声一点: 'quieter',
  上一首: 'prev',
};
const COMMAND_CASES: Case[] = Object.entries(COMMAND_EXPECT).map(([text, expect]) => ({
  text,
  expect,
  group: 'command' as const,
}));

const SEMANTIC_CASES: Case[] = ['这歌太吵了', '换个安静点的', '声音有点小听不清', '别放这首了', '就这首挺好别换'].map(
  (text) => ({ text, expect: 'n/a(不设硬门槛)', group: 'semantic' as const }),
);

const CASES: Case[] = [...COLLISION_CASES, ...COMMAND_CASES, ...SEMANTIC_CASES];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postChat(roomId: string, text: string): Promise<{ contentText: string; speakableMs: number; ok: boolean; err?: string }> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/chat/completions?session=${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: 'myjavis', messages: [{ role: 'user', content: text }] }),
    });
  } catch (err) {
    return { contentText: '', speakableMs: -1, ok: false, err: (err as Error).message };
  }
  if (!res.ok || !res.body) return { contentText: '', speakableMs: -1, ok: false, err: `HTTP ${res.status}` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentText = '';
  let speakableMs = -1;
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
        const evt = JSON.parse(chunk) as { choices?: Array<{ delta?: { content?: string } }> };
        const c = evt.choices?.[0]?.delta?.content;
        if (c) {
          if (speakableMs < 0) speakableMs = performance.now() - started;
          contentText += c;
        }
      } catch {
        /* 忽略噪声 chunk */
      }
    }
  }
  return { contentText, speakableMs, ok: true };
}

/** 种一首歌：走既有点歌正则（不受 FC 影响，不走 LLM），制造「有活跃音乐会话」状态。 */
async function seedRoom(roomId: string): Promise<void> {
  await postChat(roomId, '播放一首夜曲');
  await sleep(950); // 等 800ms 播放提交去抖窗口过去，确保 recordPlay 已落地
}

interface CaseResult {
  case: Case;
  provider: string;
  actualAction: string;
  toolCalled: boolean;
  speakableMs: number;
  replyPrefix: string;
  verdict: 'PASS' | 'FAIL' | 'INFO' | 'ERROR';
  note: string;
}

async function main(): Promise<void> {
  console.log(`Gate2 跑批：baseUrl=${BASE_URL} log=${SERVER_LOG_PATH} fcOff=${FC_OFF} 共 ${CASES.length} 条`);
  const results: CaseResult[] = [];
  let idx = 0;
  for (const c of CASES) {
    idx += 1;
    const roomId = `gate2-${FC_OFF ? 'off' : 'on'}-c${String(idx).padStart(2, '0')}`;
    await seedRoom(roomId);
    const { contentText, speakableMs, ok, err } = await postChat(roomId, c.text);

    if (!ok) {
      results.push({
        case: c,
        provider: '-',
        actualAction: '-',
        toolCalled: false,
        speakableMs: -1,
        replyPrefix: '',
        verdict: 'ERROR',
        note: err ?? 'unknown error',
      });
      console.log(`[${c.group}] "${c.text}" → ERROR ${err}`);
      continue;
    }

    // ground truth 来自 server 端 [music-fc] 日志行（SSE 响应本身绝不含 tool_call 信息，这是设计要求）。
    const log = readFileSync(SERVER_LOG_PATH, 'utf-8');
    const re = new RegExp(`\\[music-fc\\] session=${roomId} tool=music_control action=(\\w+) speakable_ms=(\\d+)`);
    const m = re.exec(log);
    const toolCalled = Boolean(m);
    const actualAction = m ? m[1]! : 'none';

    let verdict: CaseResult['verdict'] = 'INFO';
    let note = '';
    if (c.group === 'collision') {
      verdict = !toolCalled ? 'PASS' : 'FAIL';
      note = toolCalled ? `误触发 action=${actualAction}` : '未误触发';
    } else if (c.group === 'command') {
      verdict = toolCalled && actualAction === c.expect ? 'PASS' : 'FAIL';
      note = !toolCalled ? '漏调（未调用工具）' : actualAction === c.expect ? '正确' : `action不符，期望${c.expect}实际${actualAction}`;
    } else {
      note = toolCalled ? `调用了 action=${actualAction}` : `纯聊天: "${contentText.slice(0, 40)}"`;
    }

    results.push({
      case: c,
      provider: 'DeepSeek(main)', // 架构决定：带 tools 的轮次固定退化单路，见 llm.ts Gate1 注释
      actualAction,
      toolCalled,
      speakableMs: Math.round(speakableMs),
      replyPrefix: contentText.slice(0, 30),
      verdict,
      note,
    });
    console.log(`[${c.group}] "${c.text}" → ${verdict} ${note} (speakable_ms=${Math.round(speakableMs)})`);
  }

  // TSV：case 期望 provider 实际action 是否调用工具 speakable_ms 回复文本首30字
  const tsvLines = ['case\t期望\tprovider\t实际action\t是否调用工具\tspeakable_ms\t回复文本首30字'];
  for (const r of results) {
    tsvLines.push(
      [r.case.text, r.case.expect, r.provider, r.actualAction, r.toolCalled ? '是' : '否', String(r.speakableMs), r.replyPrefix.replace(/\t|\n/g, ' ')].join(
        '\t',
      ),
    );
  }
  const tsvPath = new URL(`../../../docs/gate2-results${FC_OFF ? '-fcoff' : ''}.tsv`, import.meta.url);
  writeFileSync(tsvPath, tsvLines.join('\n') + '\n', 'utf-8');
  console.log(`\nTSV 已写入: ${tsvPath.pathname}`);

  // 门槛核对（§5.2）
  const collisionResults = results.filter((r) => r.case.group === 'collision');
  const commandResults = results.filter((r) => r.case.group === 'command');
  const collisionFail = collisionResults.filter((r) => r.verdict === 'FAIL').length;
  const commandPass = commandResults.filter((r) => r.verdict === 'PASS').length;
  const speakableMsSorted = results
    .filter((r) => r.speakableMs >= 0 && r.case.group !== 'semantic')
    .map((r) => r.speakableMs)
    .sort((a, b) => a - b);
  const p95Idx = Math.min(speakableMsSorted.length - 1, Math.ceil(speakableMsSorted.length * 0.95) - 1);
  const p95 = speakableMsSorted[p95Idx] ?? -1;

  console.log('\n=== 门槛核对（§5.2） ===');
  console.log(`撞词误触发: ${collisionFail}/${collisionResults.length}（门槛 0/10）→ ${collisionFail === 0 ? '✅ 达标' : '❌ 不达标'}`);
  console.log(
    `真指令正确率: ${commandPass}/${commandResults.length}（门槛 ≥9/10，本次样本 ${commandResults.length} 条）→ ${
      commandPass / commandResults.length >= 0.9 ? '✅ 达标' : '❌ 不达标'
    }`,
  );
  console.log(`speakable_ms p95: ${p95}ms（门槛 ≤1200ms）→ ${p95 >= 0 && p95 <= 1200 ? '✅ 达标' : '❌ 不达标'}`);
}

main().catch((err) => {
  console.error('Gate2 脚本异常:', err);
  process.exit(1);
});
