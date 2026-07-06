/**
 * 火山 RTC 实时对话「CustomLLM」回调端点（抽取自 P003 routes/custom-llm.ts，剥离小可业务）。
 *
 * 火山 AIGC-RTC Server 把 ASR 转出的文本 + 对话历史，以 **OpenAI ChatCompletion 格式** POST 到此端点，
 * 我们以 **SSE 流**（text/event-stream + data:[DONE]）返回助手回复；火山再把文本送 TTS 播给用户。
 * 即：火山只当「语音 I/O + 编排管道」，**助手的大脑（人设 + 安全 + 记忆注入 + LLM）全留在这里**。
 *
 * 身份/会话映射（抽取自 P003）：
 *  - ?session=roomId → prompt override（调试台实时调 prompt）
 *  - ?user=userId    → mock 声纹输入（真实火山 payload 后续批次接入）。
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { assemblePrompt } from '../prompt/orchestrator.js';
import { createLlm } from '../providers/llm.js';
import { getPromptOverride } from '../rtc-prompt-override.js';
import { eventLog, identity, memory, mockIdentityPayload } from '../memory/index.js';
import { fillerConfig, fillerPicker } from '../fillers.js';
import { networkRttFromHeaders, TurnTrace, writeTelemetry } from '../telemetry.js';
import {
  bumpNameRetry,
  clearEnroll,
  detectEnrollIntent,
  enrollAskNameLine,
  enrollFullLine,
  enrollGuideLine,
  enrollNameRetryLine,
  enrollReplaceLine,
  extractNameReply,
  getEnroll,
  isEnrollCancel,
  listeningAck,
  startEnroll,
  startEnrollAwaitingName,
} from '../voiceprint/enroll-session.js';
import { detectMusicIntent } from '../music/music-intent.js';
import { musicPlay } from '../music/orchestrator-client.js';
import { setPending } from '../music/pending-store.js';
import { getMusicSession, recordPlay } from '../music/music-session.js';
import { buildStreamUrl } from '../music/stream-url.js';
import { config } from '../config.js';
import { MAX_ACTIVE_VOICEPRINTS, findByDisplayName, listActiveVoiceprints } from '../voiceprint/registry.js';
import { parseSpeakerTag, resolveSpeakerFromTag, stripSpeakerTag } from '../voiceprint/speaker-tag.js';
import { getTenant } from '../tenant/registry.js';
import type { ChatTurn } from '../providers/types.js';
import type { VolcSpeakerPayload } from '../memory/types.js';

const customLlmRoute = new Hono();

// 身份粘滞缓存：房间 → 最近一次稳定声纹标签的说话人（短句无标签轮沿用称呼，仅体验层）
const STICKY_SPEAKER_TTL_MS = 30_000;
const stickySpeakers = new Map<string, { displayName: string; ts: number }>();

type OpenAiMessage = { role: string; content: unknown };
type CustomLlmBody = {
  messages?: OpenAiMessage[];
  model?: string;
  speaker_evidence?: VolcSpeakerPayload;
  speakerEvidence?: VolcSpeakerPayload;
};

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

  let body: CustomLlmBody;
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: { message: 'invalid json body' } }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const chat = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastUserIdx = chat.map((m) => m.role).lastIndexOf('user');
  const rawUserText = lastUserIdx >= 0 ? extractText(chat[lastUserIdx]!.content) : '';
  // 声纹识别标签（Mode=2 火山拼进消息文本）：剥出身份信号，LLM/记忆只见干净文本。
  // history 里每条 user 消息同样清洗（多轮对话每轮都可能带标签）。
  const { cleanText: userText, audioName: speakerAudioName } = parseSpeakerTag(rawUserText);
  const history: ChatTurn[] = chat.slice(0, Math.max(lastUserIdx, 0)).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.role === 'user' ? stripSpeakerTag(extractText(m.content)) : extractText(m.content),
  }));

  const sessionId = c.req.query('session') ?? undefined; // roomId → prompt override 键
  const userId = c.req.query('user') ?? undefined; // mock voiceprintId / 后续 account hint
  // 租户上下文（批次A）：/rtc/start 拼进回调 URL 的 ?tenant=；载入自配 persona/称呼。
  const tenant = getTenant(c.req.query('tenant')?.trim() ?? '') ?? undefined;
  // 身份来源优先级：火山标签（生产真实信号）> body.speaker_evidence（预留）> query mock（调试）。
  // 标签归属校验：反查出的声纹若不属于本房间租户（理论上不可能，IdList 只带本租户），按无标签处理。
  const rawTagSpeaker = speakerAudioName ? resolveSpeakerFromTag(speakerAudioName, sessionId) : undefined;
  const tagSpeaker =
    rawTagSpeaker?.record && tenant && rawTagSpeaker.record.tenantId !== tenant.id ? undefined : rawTagSpeaker;
  const speakerPayload =
    tagSpeaker?.payload ??
    extractSpeakerPayload(body, {
      roomId: sessionId,
      queryVoiceprintId: c.req.query('voiceprintId') ?? userId,
      queryVoiceprintName: c.req.query('voiceprintName') ?? userId,
      queryScore: c.req.query('score'),
      queryStatus: c.req.query('speakerStatus'),
    });
  const identityResolution = identity.resolve(speakerPayload);
  // 身份粘滞（体验层）：短句（1-2s）声纹特征不足打不出标签是物理特性——同房间 30s 内有过
  // 稳定标签就沿用其"称呼"，只影响 LLM 怎么叫人；记忆归属仍走本轮真实证据（无标签=quarantine），
  // 串账风险为零。
  const taggedName = tagSpeaker?.record?.displayName;
  if (taggedName && sessionId) {
    stickySpeakers.set(sessionId, { displayName: taggedName, ts: Date.now() });
  }
  const sticky = !taggedName && sessionId ? stickySpeakers.get(sessionId) : undefined;
  const stickyName = sticky && Date.now() - sticky.ts < STICKY_SPEAKER_TTL_MS ? sticky.displayName : undefined;
  const speakerName = taggedName ?? stickyName;
  const turnTrace = new TurnTrace({
    roomId: sessionId ?? 'unknown-room',
    turnId: `${sessionId ?? 'room'}-${Date.now()}`,
    identity: identityResolution,
    networkRttMs: networkRttFromHeaders(c.req.raw.headers),
  });

  // override（调试台实时调的 prompt）优先：直接用它（自带完整内容）；否则走默认人设组装 + 记忆注入。
  const overridePrompt = getPromptOverride(sessionId);
  const contextBundle =
    !overridePrompt && userText.trim()
      ? await turnTrace.measure('memoryReadMs', () =>
          memory
            .recall({
              ownerId: identityResolution.ownerId,
              query: userText,
              working: history.map((turn) => ({ role: turn.role, content: turn.content, ts: Date.now() })),
              limit: 8,
            })
            .catch((err) => ({
              memories: [],
              working: [],
              readMemoryIds: [],
              injectedMemoryIds: [],
              usedProvisional: false,
              degradationReason: err instanceof Error ? err.message : String(err),
              elapsedMs: 0,
            })),
        )
      : undefined;
  if (contextBundle) {
    turnTrace.addMemoryUse({
      readMemoryIds: contextBundle.readMemoryIds,
      injectedMemoryIds: contextBundle.injectedMemoryIds,
      degradationReason: contextBundle.degradationReason,
      usedProvisional: contextBundle.usedProvisional,
    });
  }
  // 身份注入走 contextNote（history 之后、当前消息之前=近因最强位）：放 system 尾部会被
  // history 惯性压过——真机实证 history 里 assistant 说过"认错了"后，LLM 无视身份段继续
  // 说"没法通过声音认人"（幻觉理由）。措辞明确指示覆盖历史立场。
  // 无声纹身份时用租户自配称呼兜底（措辞区分：声纹=确认；称呼=礼貌默认，不冒充身份判断）。
  const speakerNote = speakerName
    ? `[系统确认] 当前说话的是：${speakerName}。你能听出 TA 的声音。直接用名字自然称呼；` +
      `即使前面对话里你说过"不认识/认错了"，现在已确认，无需道歉解释，正常继续即可。` +
      `不要提"声纹/识别/系统/确认"这类机制词。`
    : tenant?.userTitle
      ? `称呼提示：如需称呼对方且不确定对方是谁，用「${tenant.userTitle}」。不要提"系统/设置"这类机制词。`
      : undefined;
  const systemPrompt =
    overridePrompt ??
    (await turnTrace.measure('promptAssemblyMs', () =>
      assemblePrompt({ memoriesAsData: contextBundle, personaExtra: tenant?.personaExtra }),
    ));

  // 可观测性（Prefill 行为分析）：请求体键集 + user 文本头部——prefill(interim) 与 final 调用的差异在此现形。
  console.log(
    `[custom-llm] session=${sessionId ?? '-'} owner=${identityResolution.ownerId ?? '-'} state=${identityResolution.state}` +
      `${speakerName ? ` [speaker:${speakerName}${taggedName ? '' : '·sticky'}]` : ''}${overridePrompt ? ' [override]' : ''}${contextBundle?.memories.length ? ` [mem:${contextBundle.memories.length}]` : ''}` +
      ` keys=[${Object.keys(body as Record<string, unknown>).join(',')}] msgs=${body.messages?.length ?? 0} user="${userText.slice(0, 20)}"`,
  );
  // 标签形态观测：正常剥离打确认；含"当前说话人"却没剥掉 = 火山标签形态与解析器不符，打告警。
  if (rawUserText !== userText || /当前说话人/.test(userText)) {
    console.log(
      `[custom-llm] speaker-tag raw="${rawUserText.slice(0, 80)}" clean="${userText.slice(0, 40)}" audioName=${speakerAudioName ?? 'UNPARSED!'}`,
    );
  }
  // ⚠️ 用户发言的溯源写入延迟到「流正常完成且连接未被火山断开」（见 onDone）：
  //    Prefill 开启后 interim 半句也会打进来，弃用的调用火山会 abort 连接——立即写入会污染
  //    event_log/记忆（半句话当 final、串账）。abort 守卫对 barge-in 弃用响应同样正确。

  // —— 声纹对话式注册（批次2）：意图命中 / 录音进行中 → server 直出话术，跳过 LLM 与记忆写入。
  //    Prefill interim 也会进这里：startEnroll 幂等（final 名字覆盖 interim），话术只播 final 版。
  const enrollCanned = resolveEnrollCanned(sessionId, userText, tenant?.id);
  if (enrollCanned) {
    console.log(`[custom-llm] enroll session=${sessionId ?? '-'} canned="${enrollCanned.slice(0, 24)}…"`);
    return streamCannedReply(c, { model: body.model ?? 'myjavis', text: enrollCanned });
  }

  const musicCanned = await resolveMusicCanned(sessionId, userText);
  if (musicCanned) {
    console.log(`[custom-llm] music session=${sessionId ?? '-'} canned="${musicCanned.slice(0, 24)}…"`);
    return streamCannedReply(c, { model: body.model ?? 'myjavis', text: musicCanned });
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
      let assistantText = '';
      // 承接句：waitMs=0 同步直插（省 setTimeout 宏任务延迟，SSE 首块即承接句）；
      // >0 时为自适应窗口（LLM 首字先到则不插）。见 fillers.ts。
      let firstTokenSeen = false;
      const insertFiller = (): void => {
        if (firstTokenSeen) return;
        const filler = fillerPicker.pick(userText);
        if (filler) {
          assistantText += filler;
          enqueue(chunk({ content: filler }, null));
          console.log(`[filler] inserted "${filler}" (wait=${fillerConfig.waitMs}ms)`);
        }
      };
      const fillerWanted = fillerConfig.enabled && Boolean(userText.trim());
      if (fillerWanted && fillerConfig.waitMs <= 0) insertFiller();
      const fillerTimer = fillerWanted && fillerConfig.waitMs > 0 ? setTimeout(insertFiller, fillerConfig.waitMs) : null;
      await llm.streamChat({
        systemPrompt,
        userText,
        history,
        contextNote: speakerNote,
        onDelta: (delta) => {
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            if (fillerTimer) clearTimeout(fillerTimer);
          }
          turnTrace.markLlmFirstToken();
          assistantText += delta;
          enqueue(chunk({ content: delta }, null));
        },
        onDone: () => {
          // abort 守卫：火山弃用本次调用（Prefill 的 interim 版被 final 取代 / barge-in）时会断开
          // 连接——此时跳过全部溯源与记忆写入，防止半句 interim 或没播出的回复污染系统。
          const discarded = c.req.raw.signal.aborted;
          if (!discarded && userText.trim()) {
            const userEvent = eventLog.appendUtterance({
              roomId: sessionId ?? 'unknown-room',
              speakerEvidenceId: identityResolution.evidence.id,
              isFinal: true,
              sourceRole: 'user',
              utteranceText: userText,
            });
            void memory
              .remember({
                ownerId: identityResolution.ownerId,
                identity: identityResolution,
                eventId: userEvent.id,
                roomId: sessionId ?? 'unknown-room',
                utterance: userText,
                sourceRole: 'user',
                isFinal: true,
                asrConfidence: 1,
              })
              .catch(() => {});
          }
          if (!discarded && assistantText.trim()) {
            eventLog.appendUtterance({
              roomId: sessionId ?? 'unknown-room',
              isFinal: true,
              sourceRole: 'assistant',
              utteranceText: assistantText.trim(),
              heardByUser: true,
            });
          }
          if (discarded) console.log(`[custom-llm] discarded (aborted) session=${sessionId ?? '-'} user="${userText.slice(0, 20)}"`);
          enqueue(chunk({}, 'stop'));
        },
        onError: (err) => enqueue(chunk({ content: `（助手出错了：${err.message}）` }, 'stop')),
      });
    } catch (err) {
      enqueue(chunk({ content: `（助手暂时连不上大脑：${(err as Error)?.message ?? err}）` }, 'stop'));
    }
    enqueue('[DONE]'); // 火山要求的终止符
    await chain;
    writeTelemetry(turnTrace.finish());
  });
});

export { customLlmRoute };

/**
 * 声纹注册流程的直出话术裁决（无命中返回 null → 走正常 LLM 链路）：
 * 1) 带名意图「我是X，记住我」：满员拒绝 / 同名重注册 / 引导（建 recording 会话）；
 * 2) 无名意图「记住我的声音」：进 awaiting_name，Javis 反问名字（真机日志证明用户不会背句式）；
 * 3) awaiting_name 中：提取名字 → 转 recording；没听出追问 ≤2 次；"算了"随时中止；
 * 4) recording 中：极简倾听哼声（避免 TTS 长回复污染录音）。
 * 带名意图检测最先：任何阶段直接说「我是B记住我」都能换名重来。
 */
function resolveEnrollCanned(roomId: string | undefined, userText: string, tenantId: string | undefined): string | null {
  if (!roomId || !userText.trim()) return null;
  if (!tenantId) return null; // 无租户上下文（老房间/调试直连）不进注册流程
  const session = getEnroll(roomId);

  const beginNamed = (displayName: string): string => {
    const sameName = findByDisplayName(tenantId, displayName);
    const existing = listActiveVoiceprints(tenantId);
    if (!sameName && existing.length >= MAX_ACTIVE_VOICEPRINTS) {
      clearEnroll(roomId);
      return enrollFullLine(existing.map((r) => r.displayName));
    }
    startEnroll(roomId, displayName);
    return sameName ? enrollReplaceLine(displayName) : enrollGuideLine(displayName);
  };

  const intent = detectEnrollIntent(userText);
  if (intent?.kind === 'named') return beginNamed(intent.displayName);

  if (session?.state === 'awaiting_name') {
    if (isEnrollCancel(userText)) {
      clearEnroll(roomId);
      return '好，那先不记了，想记的时候随时说。';
    }
    const name = extractNameReply(userText);
    if (name) return beginNamed(name);
    if (bumpNameRetry(roomId)) return enrollNameRetryLine();
    clearEnroll(roomId);
    return '那咱们先聊着，想记声音的时候说"我叫某某，记住我的声音"就行。';
  }

  if (intent?.kind === 'unnamed') {
    const existing = listActiveVoiceprints(tenantId);
    if (existing.length >= MAX_ACTIVE_VOICEPRINTS) {
      return enrollFullLine(existing.map((r) => r.displayName));
    }
    startEnrollAwaitingName(roomId);
    return enrollAskNameLine();
  }

  if (session?.state === 'recording') {
    if (isEnrollCancel(userText)) {
      clearEnroll(roomId);
      return '好，先不记了。';
    }
    return listeningAck();
  }
  return null;
}

/**
 * 音乐意图短路（与 enroll 同级，enroll 已优先）。
 * 命中后直出话术 + 通过 pending-store 通知前端播放/控制。
 * 仅当 MUSIC_ORCHESTRATOR_URL 配置时启用，否则优雅返回 null。
 */
/** playing 结果 → 设播放 pending + 记录（供"换一首"）+ 返回话术；非 playing 返回对应话术。 */
function handlePlayResult(
  roomId: string,
  query: string,
  playRes: Awaited<ReturnType<typeof musicPlay>>,
  prefix: string,
): string {
  if (!playRes) return '音乐服务暂时连不上，稍后再试试？';
  if (playRes.status === 'ambiguous' && playRes.candidates && playRes.candidates.length > 0) {
    const names = playRes.candidates.slice(0, 3).map((c) => `《${c.title}》`).join('、');
    return `找到好几个，你是要${names}吗？`;
  }
  if (playRes.status === 'playing' && playRes.track) {
    const track = playRes.track;
    const fullUrl = buildStreamUrl(playRes.stream_url || track.stream_url || '');
    if (fullUrl) {
      setPending(roomId, { action: 'play', streamUrl: fullUrl, title: track.title });
      recordPlay(roomId, query, track.id);
    }
    return `${prefix}《${track.title}》`;
  }
  if (playRes.status === 'not_found') return '没找到这首诶，换个说法试试？';
  return '没找到诶，换个说法试试？';
}

async function resolveMusicCanned(roomId: string | undefined, userText: string): Promise<string | null> {
  if (!roomId || !userText.trim() || !config.music.enabled) return null;
  const intent = detectMusicIntent(userText);
  if (!intent) return null;

  if (intent.kind === 'play') {
    const playRes = await musicPlay(intent.query, roomId);
    return handlePlayResult(roomId, intent.query, playRes, '好，给你放');
  }

  if (intent.kind === 'play_generic') {
    // 识别到"想放音乐"但没有具体歌名/歌手（如"播放音乐"）——反问，不静默忽略
    return '想听谁的歌，或者什么风格？跟我说一声～';
  }

  if (intent.kind === 'control') {
    // "换一首/下一首"：用上次的 query 重搜、排除已放过的，真换一首歌（不是空 stub）
    if (intent.action === 'next') {
      const ms = getMusicSession(roomId);
      if (ms?.lastQuery) {
        const playRes = await musicPlay(ms.lastQuery, roomId, ms.playedIds);
        return handlePlayResult(roomId, ms.lastQuery, playRes, '换一首，给你放');
      }
      return '现在还没在放歌呢，想听什么跟我说～';
    }
    // 其余控制（暂停/继续/上一首/音量）走前端 <audio> 控制
    setPending(roomId, { action: 'control', control: intent.action });
    const acks: Record<string, string> = {
      pause: '好嘞，暂停。',
      resume: '继续播～',
      prev: '上一首。',
      louder: '调大声点。',
      quieter: '小声点。',
    };
    return acks[intent.action] || '好。';
  }

  return null;
}

/** 以标准 ChatCompletion SSE 形态直出一段固定文本（火山按正常 LLM 回复送 TTS）。 */
function streamCannedReply(c: Context, args: { model: string; text: string }): Response {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: args.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: chunk({ role: 'assistant', content: '' }, null) });
    await stream.writeSSE({ data: chunk({ content: args.text }, null) });
    await stream.writeSSE({ data: chunk({}, 'stop') });
    await stream.writeSSE({ data: '[DONE]' });
  });
}

function extractSpeakerPayload(
  body: CustomLlmBody,
  fallback: {
    roomId?: string;
    queryVoiceprintId?: string;
    queryVoiceprintName?: string;
    queryScore?: string;
    queryStatus?: string;
  },
): VolcSpeakerPayload {
  const fromBody = body.speaker_evidence ?? body.speakerEvidence;
  if (fromBody) return { ...fromBody, roomId: fromBody.roomId ?? fallback.roomId };
  return mockIdentityPayload({
    roomId: fallback.roomId,
    voiceprintId: fallback.queryVoiceprintId,
    voiceprintName: fallback.queryVoiceprintName,
    score: fallback.queryScore ? Number(fallback.queryScore) : fallback.queryVoiceprintId ? 0.9 : undefined,
    status: fallback.queryStatus,
  });
}
