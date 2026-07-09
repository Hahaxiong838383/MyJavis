import assert from 'node:assert/strict';
import { buildMusicContextNote, MUSIC_CONTROL_TOOL, parseMusicControlAction } from '../src/routes/custom-llm.js';
import { recordPlay, setAwaitingChoice, getMusicSession } from '../src/music/music-session.js';
import { createLlm } from '../src/providers/llm.js';

// —— parseMusicControlAction：§4.3「action 不在枚举 / JSON 解析失败 → 忽略工具调用（宁漏勿误）」——
for (const action of ['pause', 'resume', 'next', 'prev', 'louder', 'quieter']) {
  assert.equal(parseMusicControlAction(`{"action":"${action}"}`), action, `合法 action ${action} 应正确解析`);
}
assert.equal(parseMusicControlAction('{"action":"teleport"}'), null, '不在枚举内应忽略');
assert.equal(parseMusicControlAction('not json'), null, 'JSON 解析失败应忽略');
assert.equal(parseMusicControlAction('{}'), null, '缺 action 字段应忽略');
assert.equal(parseMusicControlAction('{"action":123}'), null, 'action 非字符串应忽略');
assert.equal(parseMusicControlAction(''), null, '空字符串应忽略');

// —— MUSIC_CONTROL_TOOL：工具定义形状回归（§4.2 已定稿，防误改） ——
assert.equal(MUSIC_CONTROL_TOOL.type, 'function');
assert.equal(MUSIC_CONTROL_TOOL.function.name, 'music_control');
const params = MUSIC_CONTROL_TOOL.function.parameters as {
  properties: { action: { enum: string[] } };
  required: string[];
};
assert.deepEqual(params.properties.action.enum, ['pause', 'resume', 'next', 'prev', 'louder', 'quieter']);
assert.deepEqual(params.required, ['action']);

// —— buildMusicContextNote：优先取播放历史栈栈顶（当前曲）标题 ——
const roomA = 'fc-test-room-current-track';
recordPlay(roomA, '周杰伦', { id: 't1', source: 'bilibili', title: '晴天' });
assert.equal(
  buildMusicContextNote(getMusicSession(roomA)!),
  '[系统状态] 当前房间正在播放音乐：《晴天》。用户若想暂停/继续/换歌/调音量，调用 music_control；普通聊天正常回复，别把聊天字眼当指令。',
);
// 只有 ambiguous 反问缓存的候选（lastQuery 已写但还没真正播放过任何一首）→ 退回 lastQuery
const roomB = 'fc-test-room-no-track-yet';
setAwaitingChoice(roomB, '周杰伦的歌', [{ id: 'c1', source: 'bilibili', title: '候选A' }]);
assert.equal(
  buildMusicContextNote(getMusicSession(roomB)!),
  '[系统状态] 当前房间正在播放音乐：《周杰伦的歌》。用户若想暂停/继续/换歌/调音量，调用 music_control；普通聊天正常回复，别把聊天字眼当指令。',
);

console.log('music-fc.test (pure logic) ok');

// —— llm.ts 流式 tool_call：mock fetch，不出网 ——
// OpenAI 兼容 SSE 帧构造：content 分片 + tool_calls 分片（按 index 聚合），仿 Gate1 探测的真实形状
// （见 docs/gate1-probe-evidence.md：DeepSeek 每次都是先说话再调工具）。
function sseFrame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const PAUSE_TOOL_CALL_FRAMES = [
  sseFrame({ role: 'assistant', content: '' }),
  sseFrame({ content: '好的' }),
  sseFrame({ content: '，暂停播放。' }),
  sseFrame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'music_control', arguments: '' } }] }),
  sseFrame({ tool_calls: [{ index: 0, function: { arguments: '{"action":' } }] }),
  sseFrame({ tool_calls: [{ index: 0, function: { arguments: '"pause"}' } }] }, 'tool_calls'),
];
const CHAT_ONLY_FRAMES = [sseFrame({ role: 'assistant', content: '' }), sseFrame({ content: '好呀，聊点什么？' }), sseFrame({}, 'stop')];

const originalFetch = globalThis.fetch;
type FetchCall = { url: string; body: { tools?: unknown[] } };
let fetchCalls: FetchCall[] = [];
let nextFrames: string[] = PAUSE_TOOL_CALL_FRAMES;

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  fetchCalls.push({ url, body: JSON.parse(init?.body as string) });
  return sseResponse(nextFrames);
}) as typeof fetch;

try {
  process.env.LLM_BASE_URL = 'https://fake-main.test/v1';
  process.env.LLM_API_KEY = 'fake-main-key';
  process.env.LLM_MODEL = 'fake-main-model';
  process.env.LLM_FALLBACK_BASE_URL = 'https://fake-fallback.test/v1';
  process.env.LLM_FALLBACK_API_KEY = 'fake-fallback-key';
  process.env.LLM_FALLBACK_MODEL = 'fake-fallback-model';

  // 场景 1：带 tools 的真指令 → tool_calls 正确聚合触发 onToolCall；onDelta 绝不泄漏 tool_call 片段（TTS 安全红线）
  fetchCalls = [];
  nextFrames = PAUSE_TOOL_CALL_FRAMES;
  const deltas: string[] = [];
  const toolCalls: Array<{ name: string; argsJson: string }> = [];
  let doneText: string | null = null;
  await createLlm().streamChat({
    systemPrompt: '你是语音助手',
    userText: '暂停',
    history: [],
    tools: [MUSIC_CONTROL_TOOL],
    onDelta: (d) => deltas.push(d),
    onToolCall: (name, argsJson) => {
      toolCalls.push({ name, argsJson });
    },
    onDone: (full) => {
      doneText = full;
    },
  });
  assert.equal(toolCalls.length, 1, '应恰好触发一次 onToolCall');
  assert.equal(toolCalls[0]!.name, 'music_control');
  assert.deepEqual(JSON.parse(toolCalls[0]!.argsJson), { action: 'pause' });
  assert.equal(deltas.join(''), '好的，暂停播放。', 'onDelta 拼接应等于 LLM 说的话，不多不少');
  for (const d of deltas) {
    assert.ok(!d.includes('tool_calls') && !d.includes('"action"'), `onDelta 片段绝不能含 tool_call 内容，实际="${d}"`);
  }
  assert.equal(doneText, '好的，暂停播放。');
  assert.equal(fetchCalls.length, 1, '带 tools 的轮次应退化单路（Gate1 结论：仅 DeepSeek 可靠）');
  assert.ok(fetchCalls[0]!.body.tools, '请求体应带 tools 字段');

  // 场景 2：纯聊天（无 tool_calls）→ onToolCall 绝不误触发
  fetchCalls = [];
  nextFrames = CHAT_ONLY_FRAMES;
  const deltas2: string[] = [];
  let toolCallFired = false;
  await createLlm().streamChat({
    systemPrompt: '你是语音助手',
    userText: '我们换一个话题',
    history: [],
    tools: [MUSIC_CONTROL_TOOL],
    onDelta: (d) => deltas2.push(d),
    onToolCall: () => {
      toolCallFired = true;
    },
    onDone: () => {},
  });
  assert.equal(toolCallFired, false, '模型没调用工具时 onToolCall 不应触发');
  assert.equal(deltas2.join(''), '好呀，聊点什么？');

  // 场景 3：无 tools 的轮次应维持双路赛马（fallback 不退化）——验证 Gate1「仅一家可靠」分支的边界
  fetchCalls = [];
  nextFrames = CHAT_ONLY_FRAMES;
  await createLlm().streamChat({
    systemPrompt: '你是语音助手',
    userText: '你好',
    history: [],
    onDelta: () => {},
    onDone: () => {},
  });
  assert.equal(fetchCalls.length, 2, '无 tools 轮应维持双路赛马（main + fallback 都发起请求）');
  assert.ok(!fetchCalls.every((c) => c.body.tools), '无 tools 轮的请求体不应带 tools 字段');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('music-fc.test (llm streaming, mocked fetch) ok');

// —— executeMusicControl（灰度上线前 cc 补）：onToolCall 与主路失败降级链共用的执行函数 ——
{
  const { executeMusicControl } = await import('../src/routes/custom-llm.js');
  const { takePending } = await import('../src/music/pending-store.js');
  const room = 'fc-test-exec-control';
  // pause/resume/音量：走前端 pending 通道 + 固定 ack（不出网）
  assert.equal(await executeMusicControl(room, 'pause'), '好嘞，暂停。');
  assert.deepEqual(takePending(room), { action: 'control', control: 'pause' }, 'pause 应写入 pending 通道');
  assert.equal(await executeMusicControl(room, 'quieter'), '小声点。');
  assert.deepEqual(takePending(room), { action: 'control', control: 'quieter' });
  // next 无音乐会话：引导话术，不出网
  assert.equal(await executeMusicControl('fc-test-exec-no-session', 'next'), '现在还没在放歌呢，想听什么跟我说～');
  // prev 空历史栈：引导话术，不出网
  assert.equal(await executeMusicControl('fc-test-exec-no-session', 'prev'), '前面没有别的歌啦，这就是第一首～');
}
console.log('music-fc.test (executeMusicControl) ok');
