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
import { extractMemoryCandidates } from '../memory/candidates.js';
import {
  consumePendingGuidance,
  GUIDANCE_CONTEXT_NOTE,
  markPendingGuidance,
  shouldGuideVoiceprintRegistration,
} from '../memory/guidance.js';
import { fillerConfig, fillerPicker } from '../fillers.js';
import { networkRttFromHeaders, TurnTrace, writeTelemetry } from '../telemetry.js';
import {
  backToAwaitingName,
  bumpNameRetry,
  clearEnroll,
  detectEnrollIntent,
  enrollAskNameLine,
  enrollConfirmNameLine,
  enrollFullLine,
  enrollGuideLine,
  enrollNameRetryLine,
  enrollReplaceLine,
  extractNameReplyDetailed,
  getEnroll,
  isConfirmNo,
  isConfirmYes,
  isEnrollCancel,
  listeningAck,
  startEnroll,
  startEnrollAwaitingName,
  startEnrollConfirmingName,
} from '../voiceprint/enroll-session.js';
import {
  clearForgetConfirm,
  detectForgetIntent,
  forgetAbortLine,
  forgetConfirmLine,
  forgetDoneLine,
  forgetFailLine,
  forgetNotFoundLine,
  forgetSelfUnknownLine,
  getForgetConfirm,
  startForgetConfirm,
} from '../voiceprint/forget-session.js';
import { deleteVoicePrint } from '../voiceprint/volc-api.js';
import { removeVoiceprint } from '../voiceprint/registry.js';
import { hasSensitiveContent } from '../memory-core/privacy.js';
import { detectMusicIntent } from '../music/music-intent.js';
import { musicPlay, musicPlayById } from '../music/orchestrator-client.js';
import { setPending } from '../music/pending-store.js';
import {
  clearAwaitingChoice,
  getAwaitingChoice,
  getMusicSession,
  recordPlay,
  setAwaitingChoice,
  takePrevTrack,
  type CandidateTrack,
} from '../music/music-session.js';
import { buildStreamUrl } from '../music/stream-url.js';
import { config } from '../config.js';
import { MAX_ACTIVE_VOICEPRINTS, findByDisplayName, listActiveVoiceprints, soloOwnerId } from '../voiceprint/registry.js';
import { parseSpeakerTag, resolveSpeakerFromTag, stripSpeakerTag } from '../voiceprint/speaker-tag.js';
import { getTenant } from '../tenant/registry.js';
import {
  askBothLine,
  askContentLine,
  askTimeLine,
  bumpRetry,
  cancelEmptyLine,
  cancelOkLine,
  clearReminderSession,
  contentRetryLine,
  detectReminderIntent,
  fmtDue,
  getReminderSession,
  giveUpLine,
  isReminderCancelWord,
  makeupNote,
  parseAwaitedContent,
  parseAwaitedTime,
  queryEmptyLine,
  setOkLine,
  startAwaiting,
  timeRetryLine,
} from '../reminder/intent.js';
import { reminderStore } from '../reminder/store.js';
import type { ChatTurn } from '../providers/types.js';
import type { RecallResult, VolcSpeakerPayload } from '../memory/types.js';

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
  // R3.5 单人模式（solo=true 默认开）：租户默认 owner 兜底，声纹识别与否都归它，整个邀请码
  // 一个记忆池开箱即用；家庭模式（solo=false）完全走原声纹 owner。三处下游：recall/remember
  // 的 ownerId + remember 内部 identityStable 判断（soloStable）。
  const effectiveOwnerId = tenant?.soloMode ? soloOwnerId(tenant.id) : identityResolution.ownerId;
  const effectiveStable = tenant?.soloMode ? true : identityResolution.state === 'active_stable';
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
              ownerId: effectiveOwnerId,
              tenantId: tenant?.id,
              roomId: sessionId,
              query: userText,
              working: history.map((turn) => ({ role: turn.role, content: turn.content, ts: Date.now() })),
              limit: 8,
            })
            .catch(
              (err): RecallResult => ({
                memories: [],
                working: [],
                readMemoryIds: [],
                injectedMemoryIds: [],
                usedProvisional: false,
                degradationReason: err instanceof Error ? err.message : String(err),
                elapsedMs: 0,
              }),
            ),
        )
      : undefined;
  if (contextBundle) {
    turnTrace.addMemoryUse({
      readMemoryIds: contextBundle.readMemoryIds,
      injectedMemoryIds: contextBundle.injectedMemoryIds,
      degradationReason: contextBundle.degradationReason,
      usedProvisional: contextBundle.usedProvisional,
      matchedKeywords: contextBundle.matchedKeywords,
      relevantCount: contextBundle.relevantCount,
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
      ? `对方是这台设备的主人，日常请自然地称呼 TA「${tenant.userTitle}」（比如打招呼、确认、结尾时带上称呼，别每句都用）。不要提"系统/设置"这类机制词。`
      : undefined;
  // 错过补报（触达档3收口）：该租户有 missed 提醒 → contextNote 让 Javis 本轮自然带出；
  // 送达标记延迟到流正常完成（onDone 且未被火山 abort），interim/barge-in 弃用轮不消耗补报。
  const missedReminders = tenant ? reminderStore().missedForTenant(tenant.id) : [];
  const makeupNoteText = missedReminders.length
    ? makeupNote(missedReminders.map((r) => ({ display: fmtDue(r.dueAt), content: r.content })))
    : undefined;
  // 引导闭环（方案A）：上一轮因身份未识别被 quarantine 过 → 这一轮消费一次性提醒标记。
  const guidanceNoteText = consumePendingGuidance(sessionId) ? GUIDANCE_CONTEXT_NOTE : undefined;
  const contextNoteText = [speakerNote, makeupNoteText, guidanceNoteText].filter(Boolean).join('\n\n') || undefined;
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

  const forgetCanned = await resolveForgetCanned(sessionId, userText, tenant?.id, speakerName);
  if (forgetCanned) {
    console.log(`[custom-llm] forget session=${sessionId ?? '-'} canned="${forgetCanned.slice(0, 24)}…"`);
    return streamCannedReply(c, { model: body.model ?? 'myjavis', text: forgetCanned });
  }

  const reminderCanned = resolveReminderCanned(sessionId, userText, tenant?.id, {
    ownerId: identityResolution.ownerId,
    speakerName,
  });
  if (reminderCanned) {
    console.log(`[custom-llm] reminder session=${sessionId ?? '-'} canned="${reminderCanned.slice(0, 30)}…"`);
    return streamCannedReply(c, { model: body.model ?? 'myjavis', text: reminderCanned });
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
        contextNote: contextNoteText,
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
              tenantId: tenant?.id,
              speakerEvidenceId: identityResolution.evidence.id,
              isFinal: true,
              sourceRole: 'user',
              utteranceText: userText,
            });
            // 引导闭环：家庭模式下这句话会因身份未识别被 quarantine → 标记下一轮口头提醒
            // （remember 是 fire-and-forget 拿不到异步结果，故用同构判定预判，见 memory/guidance.ts）。
            if (shouldGuideVoiceprintRegistration(tenant?.soloMode, identityResolution.state, extractMemoryCandidates(userText).length)) {
              markPendingGuidance(sessionId ?? 'unknown-room');
            }
            void memory
              .remember({
                ownerId: effectiveOwnerId,
                tenantId: tenant?.id,
                identity: identityResolution,
                soloStable: effectiveStable,
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
            // R2 隐私：助手回复可能复述用户隐私（"好的，你对X过敏我记住了"）——命中敏感词
            // 的回复只存脱敏占位（生产实测抓到 event_log 泄露路径，2026-07-07）
            const spoken = assistantText.trim();
            eventLog.appendUtterance({
              roomId: sessionId ?? 'unknown-room',
              tenantId: tenant?.id,
              isFinal: true,
              sourceRole: 'assistant',
              utteranceText: hasSensitiveContent(spoken) ? '[隐私脱敏:助手回复]' : spoken,
              heardByUser: true,
            });
          }
          if (!discarded && missedReminders.length) {
            // 补报已随本轮回复带出（火山未弃播）→ 消耗掉，防每轮重复念
            for (const r of missedReminders) reminderStore().markDelivered(r.id, 'makeup');
            console.log(`[reminder] ${missedReminders.length} missed reminder(s) delivered via makeup`);
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
    const reply = extractNameReplyDetailed(userText);
    // 带"我叫"前缀的名字句式明确直接开录；裸名字（真机"唱歌"误注册事故形态）先复述确认（S1）
    if (reply && !reply.bare) return beginNamed(reply.name);
    if (reply?.bare) {
      startEnrollConfirmingName(roomId, reply.name);
      return enrollConfirmNameLine(reply.name);
    }
    if (bumpNameRetry(roomId)) return enrollNameRetryLine();
    clearEnroll(roomId);
    return '那咱们先聊着，想记声音的时候说"我叫某某，记住我的声音"就行。';
  }

  if (session?.state === 'confirming_name') {
    if (isEnrollCancel(userText)) {
      clearEnroll(roomId);
      return '好，那先不记了。';
    }
    if (isConfirmYes(userText)) return beginNamed(session.displayName);
    if (isConfirmNo(userText)) {
      // "不对，我叫川哥"一句话里带了纠正名 → 直接换名（带前缀才收）
      const corrected = extractNameReplyDetailed(userText.replace(/^[^，。,]{0,4}[，。,]\s*/, ''));
      if (corrected && !corrected.bare) return beginNamed(corrected.name);
      backToAwaitingName(roomId);
      return enrollNameRetryLine();
    }
    const reply = extractNameReplyDetailed(userText);
    if (reply && !reply.bare) return beginNamed(reply.name); // 直接改口"我叫XX"
    if (bumpNameRetry(roomId)) return enrollConfirmNameLine(session.displayName);
    clearEnroll(roomId);
    return '那咱们先聊着，想记声音的时候再说。';
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
 * S2 语音删除声纹裁决（async：确认后真调火山删除）。
 * 注册流程进行中不响应（enroll session 活跃时让位，防两个状态机抢同一句"对"）；
 * 删除不可逆 → 必二次确认；确认执行的 interim/final 双触发由 clearForgetConfirm 幂等兜住。
 */
async function resolveForgetCanned(
  roomId: string | undefined,
  userText: string,
  tenantId: string | undefined,
  speakerName: string | undefined,
): Promise<string | null> {
  if (!roomId || !userText.trim() || !tenantId) return null;
  if (getEnroll(roomId)) return null;

  const intent = detectForgetIntent(userText);
  if (intent) {
    const existing = listActiveVoiceprints(tenantId);
    const targetName = intent.target === 'SELF' ? speakerName : intent.target;
    if (!targetName) return forgetSelfUnknownLine(existing.map((r) => r.displayName));
    const rec = findByDisplayName(tenantId, targetName);
    if (!rec) return forgetNotFoundLine(targetName, existing.map((r) => r.displayName));
    startForgetConfirm(roomId, rec.voiceprintId, rec.displayName);
    return forgetConfirmLine(rec.displayName);
  }

  const confirm = getForgetConfirm(roomId);
  if (!confirm) return null;
  if (isConfirmYes(userText)) {
    clearForgetConfirm(roomId);
    try {
      await deleteVoicePrint(confirm.voiceprintId);
    } catch (err) {
      console.log(`[voiceprint] forget volc delete failed id=${confirm.voiceprintId}: ${(err as Error).message.slice(0, 80)}`);
      return forgetFailLine();
    }
    removeVoiceprint(confirm.voiceprintId);
    console.log(`[voiceprint] forgotten via voice id=${confirm.voiceprintId} name=${confirm.displayName}`);
    return forgetDoneLine(confirm.displayName);
  }
  if (isConfirmNo(userText) || isEnrollCancel(userText)) {
    clearForgetConfirm(roomId);
    return forgetAbortLine();
  }
  return null; // 答非所问：confirm 留到 TTL，本句走正常链路
}

/**
 * reminder 创建去抖（同 schedulePlayCommit 范式）：Prefill interim 半句「提醒我三点开」
 * 与 final「提醒我三点开会」都会命中意图——创建延迟 800ms 提交，同房间新 set 覆盖旧的，
 * 最后一个（final）赢。复述话术即时直出（interim 版被火山 abort 不播，final 版播）。
 */
const reminderCommitTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleReminderCommit(
  roomId: string,
  args: { tenantId: string; content: string; dueAt: number; ownerId?: string; speakerName?: string },
): void {
  const old = reminderCommitTimers.get(roomId);
  if (old) clearTimeout(old);
  reminderCommitTimers.set(
    roomId,
    setTimeout(() => {
      reminderCommitTimers.delete(roomId);
      const r = reminderStore().create({ ...args, roomId });
      console.log(`[reminder] created id=${r.id} due=${fmtDue(r.dueAt)} "${r.content.slice(0, 24)}" tenant=${args.tenantId}`);
    }, 800),
  );
}

/** cancel 去抖（interim+final 双触发会连删两条）：同房间 1.5s 窗口只执行一次。 */
const lastCancelAt = new Map<string, number>();

/**
 * reminder 意图短路裁决（无命中返回 null → 走后续链路）。
 * 优先级：新意图（cancel/query/set）> 反问会话接续（awaiting_time/awaiting_content）。
 * 新 set 意图永远能重开流程（用户换个说法重新说全）；设置成功 = 复述确认（可语音取消）。
 */
function resolveReminderCanned(
  roomId: string | undefined,
  userText: string,
  tenantId: string | undefined,
  speaker: { ownerId?: string; speakerName?: string },
): string | null {
  if (!roomId || !userText.trim() || !tenantId) return null;

  const commitSet = (content: string, dueAt: number, display: string): string => {
    clearReminderSession(roomId);
    scheduleReminderCommit(roomId, {
      tenantId,
      content,
      dueAt,
      ownerId: speaker.ownerId,
      speakerName: speaker.speakerName,
    });
    return setOkLine(display, content);
  };

  const intent = detectReminderIntent(userText);
  if (intent?.kind === 'cancel') {
    clearReminderSession(roomId);
    const last = lastCancelAt.get(roomId) ?? 0;
    if (Date.now() - last < 1500) return null; // interim 已处理过，final 版静默走开（话术已播）
    lastCancelAt.set(roomId, Date.now());
    // 若有未提交的创建（800ms 窗口内"设了马上取消"）：撤销提交即可
    const pendingCommit = reminderCommitTimers.get(roomId);
    if (pendingCommit) {
      clearTimeout(pendingCommit);
      reminderCommitTimers.delete(roomId);
      return '好，那条提醒不设了。';
    }
    const cancelled = reminderStore().cancelLatest(tenantId);
    return cancelled ? cancelOkLine(cancelled.content, fmtDue(cancelled.dueAt)) : cancelEmptyLine();
  }

  if (intent?.kind === 'query') {
    const items = reminderStore().upcomingForTenant(tenantId, 5);
    if (!items.length) return queryEmptyLine();
    const list = items.map((r, i) => `${i + 1}、${fmtDue(r.dueAt)}${r.content.length > 20 ? `${r.content.slice(0, 20)}…` : r.content}`).join('；');
    return `你有 ${items.length} 条提醒：${list}。`;
  }

  if (intent?.kind === 'set') {
    const { content, time, dateOffset } = intent;
    if (time && content) return commitSet(content, time.dueAt, time.display);
    if (time && !content) {
      startAwaiting(roomId, { state: 'awaiting_content', dueAt: time.dueAt, display: time.display });
      return askContentLine(time.display);
    }
    if (!time && content) {
      startAwaiting(roomId, { state: 'awaiting_time', content, dateOffset: dateOffset ?? 0 });
      return askTimeLine(content);
    }
    startAwaiting(roomId, { state: 'awaiting_time', dateOffset: dateOffset ?? 0 });
    return askBothLine();
  }

  const session = getReminderSession(roomId);
  if (!session) return null;

  if (isReminderCancelWord(userText)) {
    clearReminderSession(roomId);
    return giveUpLine();
  }

  if (session.state === 'awaiting_time') {
    const parsed = parseAwaitedTime(userText, session);
    if (parsed) {
      if (session.content) return commitSet(session.content, parsed.dueAt, parsed.display);
      startAwaiting(roomId, { state: 'awaiting_content', dueAt: parsed.dueAt, display: parsed.display });
      return askContentLine(parsed.display);
    }
    if (bumpRetry(roomId)) return timeRetryLine();
    clearReminderSession(roomId);
    return giveUpLine();
  }

  // awaiting_content
  const content = parseAwaitedContent(userText);
  if (content && session.dueAt) return commitSet(content, session.dueAt, session.display ?? fmtDue(session.dueAt));
  if (bumpRetry(roomId)) return contentRetryLine();
  clearReminderSession(roomId);
  return giveUpLine();
}

/**
 * 音乐意图短路（与 enroll 同级，enroll 已优先）。
 * 命中后直出话术 + 通过 pending-store 通知前端播放/控制。
 * 仅当 MUSIC_ORCHESTRATOR_URL 配置时启用，否则优雅返回 null。
 */
/**
 * B 站标题又臭又长——播报/反问时剪短。
 * 优先级：query 本身出现在标题里 → 直接报 query（"夜曲"）；含 query 的《》段；截前 18 字。
 * ⚠️ 不能盲取第一个《》：B 站标题尾部常挂专辑宣传（曾把《夜曲》MV 播报成"《最伟大的作品》"）。
 */
function shortTitle(title: string, query?: string): string {
  const q = query?.trim();
  if (q && q.length >= 2 && q.length <= 20 && title.includes(q)) return q;
  if (q) {
    const hit = [...title.matchAll(/《([^》]{1,24})》/g)].map((m) => m[1]!).find((b) => b.includes(q));
    if (hit) return hit;
  }
  return title.length > 18 ? `${title.slice(0, 18)}…` : title;
}

/**
 * play 提交去抖（2026-07-06 真机日志实锤修复）：火山 Prefill 的 interim 半句同样会打进
 * custom-llm——"给我播放周杰伦其他的歌"途中，半句"给我播放周杰""播放一"各自命中意图、
 * 各自 setPending 真的播了歌（前端轮询恰好取走 interim 版）。修：播放指令延迟 800ms 提交，
 * 期间同房间新的 play 意图覆盖旧的（final 总在 interim 之后 <1s 内到）——最后一个赢。
 * 800ms 延迟被"好，给你放"的 TTS 播报完全掩盖，体感无感。
 */
const playCommitTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePlayCommit(roomId: string, cmd: { streamUrl: string; title: string }, query: string, track: CandidateTrack): void {
  const old = playCommitTimers.get(roomId);
  if (old) clearTimeout(old);
  playCommitTimers.set(
    roomId,
    setTimeout(() => {
      playCommitTimers.delete(roomId);
      setPending(roomId, { action: 'play', streamUrl: cmd.streamUrl, title: cmd.title });
      recordPlay(roomId, query, track);
      console.log(`[music] play committed room=${roomId} "${cmd.title.slice(0, 24)}"`);
    }, 800),
  );
}

/** playing 结果 → 设播放 pending + 记录（供"换一首"）+ 返回话术；ambiguous 存候选反问。 */
function handlePlayResult(
  roomId: string,
  query: string,
  playRes: Awaited<ReturnType<typeof musicPlay>>,
  prefix: string,
): string {
  if (!playRes) return '音乐服务暂时连不上，稍后再试试？';
  if (playRes.status === 'ambiguous' && playRes.candidates && playRes.candidates.length > 0) {
    // 存候选（60s）——用户下一句"第一个/更具体的歌名"由 resolveChoiceReply 接住
    const cands = playRes.candidates.slice(0, 3).map((c) => ({
      id: c.id,
      source: c.source,
      title: c.title,
      artist: c.artist,
    }));
    setAwaitingChoice(roomId, query, cands);
    const names = cands.map((c, i) => `${i + 1}、${shortTitle(c.title)}`).join('；');
    return `找到几个：${names}。要哪个？说得更具体点也行。`;
  }
  if (playRes.status === 'playing' && playRes.track) {
    const track = playRes.track;
    const fullUrl = buildStreamUrl(playRes.stream_url || track.stream_url || '');
    if (fullUrl) {
      schedulePlayCommit(
        roomId,
        { streamUrl: fullUrl, title: track.title },
        query,
        { id: track.id, source: track.source, title: track.title, artist: track.artist },
      );
    }
    // 播报保险：shortTitle 剪不短（>12 字）= query 未命中标题 = 十有八九是 interim 截断
    // query 搜出的无关结果（真机曾念出"《【扒】喷火的爹，舌头肿了两周…》"）——不念标题，
    // 歌名交给播放条 UI 显示；剪得短的（query 命中）照常念，保留确认感。
    const st = shortTitle(track.title, query);
    return st.length > 12 ? `${prefix}～` : `${prefix}《${st}》`;
  }
  if (playRes.status === 'not_found') return '没找到这首诶，换个说法试试？';
  return '没找到诶，换个说法试试？';
}

const ORDINAL_MAP: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, '1': 1, '2': 2, '3': 3 };

/** 解析"第一个/第2首/一/1"这类序号回答（1-based；解析不出返回 null）。导出供测试。 */
export function parseOrdinal(text: string): number | null {
  const m = /^(?:第|就|要)?\s*(?:第)?([一二两三123])\s*(?:个|首|条)?[吧呀啊哦呢嘛！!。.]*$/.exec(text.trim());
  if (!m) return null;
  return ORDINAL_MAP[m[1]!] ?? null;
}

/**
 * ambiguous 反问后的回答衔接（2026-07-06 真机 bug 修复：反问"要哪个"后用户答
 * "周杰伦的夜曲"曾无人接、掉进普通聊天）。优先级：
 * 取消 > 序号选择 > 候选模糊匹配 > 短文本当补全 query 重搜 > 不像回答（交回常规链路）。
 */
async function resolveChoiceReply(
  roomId: string,
  userText: string,
  candidates: CandidateTrack[],
): Promise<string | null> {
  const t = userText.trim();
  if (/(算了|不用了|不要了|取消|不听了|都不是|都不要)/.test(t)) {
    clearAwaitingChoice(roomId);
    return '好，那先不放了。';
  }
  const ord = parseOrdinal(t);
  if (ord !== null && ord >= 1 && ord <= candidates.length) {
    const c = candidates[ord - 1]!;
    clearAwaitingChoice(roomId);
    const res = await musicPlayById(c, roomId);
    return handlePlayResult(roomId, c.title, res, '好，给你放');
  }
  // 候选内容匹配：用户念了候选里的歌名/歌手片段（去语气词后按字符包含判断）
  const norm = t.replace(/[吧呀啊哦呢嘛的了！!。.，,\s]/g, '');
  if (norm.length >= 2) {
    const hit = candidates.find((c) => {
      const hay = `${c.title}${c.artist ?? ''}`.replace(/\s/g, '');
      return hay.includes(norm) || (norm.length >= 4 && norm.includes((c.artist ?? '').replace(/\s/g, '')) && !!c.artist);
    });
    if (hit) {
      clearAwaitingChoice(roomId);
      const res = await musicPlayById(hit, roomId);
      return handlePlayResult(roomId, hit.title, res, '好，给你放');
    }
  }
  // 短文本 = 用户在补全信息（"周杰伦的夜曲"）→ 当新 query 重搜（子串信号已增强，命中率高）
  if (t.length <= 20) {
    clearAwaitingChoice(roomId);
    const query = t.replace(/[吧呀啊哦呢嘛！!。.，,?？]+$/u, '').trim();
    const res = await musicPlay(query, roomId);
    return handlePlayResult(roomId, query, res, '好，给你放');
  }
  return null; // 长文本/明显换话题 → 调用方清态后走常规链路
}

/** 纯唤醒词文本（"贾维斯/贾维斯贾维斯/你好，贾维斯"）——active 态用户喊唤醒词测试时，
 *  不能让 LLM 当闲聊接（曾回"嗯嗯。哦。"迷惑用户）；秒回"我在"给确定感。
 *  去掉标点后整句只剩唤醒词组合才拦，带指令的（"贾维斯放首歌"）不受影响。 */
function isPureWakeWord(text: string): boolean {
  const norm = text.replace(/[^一-龥a-zA-Z]/g, '').toLowerCase();
  return /^(?:嗨|哈喽|哈啰|hi|hey|你好)?贾维斯(?:你好)?(?:贾维斯)?$/.test(norm) && norm.includes('贾维斯');
}

async function resolveMusicCanned(roomId: string | undefined, userText: string): Promise<string | null> {
  if (!roomId || !userText.trim() || !config.music.enabled) return null;

  if (isPureWakeWord(userText)) return '我在，你说～';

  // 候选等待态优先（反问后的第一优先衔接；resolveChoiceReply 返回 null = 不像在选歌）
  const pendingChoice = getAwaitingChoice(roomId);
  if (pendingChoice) {
    const reply = await resolveChoiceReply(roomId, userText, pendingChoice);
    if (reply !== null) return reply;
    clearAwaitingChoice(roomId); // 用户换话题了：清态走常规
  }

  const intent = detectMusicIntent(userText);
  if (!intent) return null;

  if (intent.kind === 'play') {
    // "播放别的 / 周杰伦其他的歌"——"别的/其他"是换歌语义不是歌名（真机曾搜出歌名叫
    // 《别的》的视频）：剥掉修饰词，剩余部分（或上次 query）+ 排除已放列表 → next 语义
    if (/(别的|其他|其它|另外)/.test(intent.query)) {
      const cleaned = intent.query.replace(/的?(别的|其他的?|其它的?|另外的?)(歌|音乐|曲子)?/g, '').trim();
      const ms = getMusicSession(roomId);
      const query = cleaned || ms?.lastQuery || '';
      if (!query) return '想听谁的歌，或者什么风格？跟我说一声～';
      const playRes = await musicPlay(query, roomId, ms?.playedIds);
      return handlePlayResult(roomId, query, playRes, '换一首，给你放');
    }
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
    // "上一首"：从播放历史栈真回上一曲（2026-07-06 前是"回本曲开头"的 stub，川哥点名要真的）
    if (intent.action === 'prev') {
      const prev = takePrevTrack(roomId);
      if (!prev) return '前面没有别的歌啦，这就是第一首～';
      const ms = getMusicSession(roomId);
      const playRes = await musicPlayById(prev, roomId);
      return handlePlayResult(roomId, ms?.lastQuery || prev.title, playRes, '回上一首，放');
    }
    // 其余控制（暂停/继续/音量）走前端 <audio> 控制
    setPending(roomId, { action: 'control', control: intent.action });
    const acks: Record<string, string> = {
      pause: '好嘞，暂停。',
      resume: '继续播～',
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
