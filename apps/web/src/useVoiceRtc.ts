import { useCallback, useRef, useState } from 'react';
import { useAppStore } from './store';
import { apiFetch } from './api';

/**
 * 火山 RTC 实时对话 Hook（抽取自 P003 useVolcRtc.ts，剥离登录/吐槽/kidshub）。
 *
 * 火山 RTC SDK（@volcengine/rtc）约 12MB → 动态 import 做 code-split。
 * 链路：start() → POST /api/rtc/start 拿 token → joinRoom → 火山全双工（ASR+TTS 在火山侧）。
 * 二进制消息（onRoomBinaryMessageReceived）带 AI 状态（听/想/说）+ 字幕。
 */

// 火山 AIGC 状态机（conv 消息 Stage.Code）
const AGENT_BRIEF = { UNKNOWN: 0, LISTENING: 1, THINKING: 2, SPEAKING: 3, INTERRUPTED: 4, FINISHED: 5 } as const;
const MSG_BRIEF = 'conv';
const MSG_SUBTITLE = 'subv';

/** TLV → { type, value }（big-endian length），移植火山 demo utils。 */
function tlv2String(tlvBuffer: ArrayBufferLike): { type: string; value: string } {
  const typeBuffer = new Uint8Array(tlvBuffer, 0, 4);
  const lengthBuffer = new Uint8Array(tlvBuffer, 4, 4);
  const valueBuffer = new Uint8Array(tlvBuffer, 8);
  let type = '';
  for (let i = 0; i < typeBuffer.length; i++) type += String.fromCharCode(typeBuffer[i]!);
  const length = (lengthBuffer[0]! << 24) | (lengthBuffer[1]! << 16) | (lengthBuffer[2]! << 8) | lengthBuffer[3]!;
  const value = new TextDecoder().decode(valueBuffer.subarray(0, length));
  return { type, value };
}

export type ConnectPhase = 'idle' | 'starting' | 'loading' | 'joining';

export interface UseVoiceRtc {
  connected: boolean;
  connecting: boolean;
  connectPhase: ConnectPhase;
  error: string | null;
  needTapToPlay: boolean;
  /** 当前房间 ID（连接中为 null）；声纹注册轮询等房间级 API 用。 */
  roomId: string | null;
  /** 起一局对话。systemPrompt: 调试台实时 prompt；userId: 记忆注入键（可选）。 */
  start: (opts?: { systemPrompt?: string; userId?: string }) => Promise<void>;
  stop: () => Promise<void>;
  resumePlay: () => void;
  /**
   * 取 RTC 音轨给律动球做 WebAudio 分析（60fps RMS+谱质心，Web SDK 音频属性报告无
   * voicePitch/spectrum 且仅 100ms 粒度，直接分析音轨更细）。
   * local=我的麦克风采集轨（复用 RTC 采集，律动球不再二开 getUserMedia）；
   * remote=Javis bot 的 TTS 下行轨。未连接/未订阅时返回 undefined（球回退合成动画）。
   */
  getAudioTrack: (kind: 'local' | 'remote') => MediaStreamTrack | undefined;
  /**
   * 静音/恢复上行麦克风（音乐守护态用）：setCaptureVolume 置 0 仍持续发静音帧——
   * 火山任务正常挂着但 ASR 听不到任何内容（零误触发），轨道保留（律动球分析源不丢）。
   */
  setMicMuted: (muted: boolean) => void;
}

const BOT_USER_ID = 'myjavis_bot'; // 与 server rtc.ts AgentConfig.UserId 一致

export function useVoiceRtc(): UseVoiceRtc {
  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setUserSubtitle = useAppStore((s) => s.setUserSubtitle);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const engineRef = useRef<any>(null);
  const vertcRef = useRef<any>(null);
  const streamIndexMainRef = useRef<any>(null); // rtcMod.StreamIndex.STREAM_INDEX_MAIN（SDK 加载后写入）
  const sessionRef = useRef<{ roomId: string; taskId: string; userId: string } | null>(null);
  const failedUsersRef = useRef<Set<string>>(new Set());
  // 声纹 AudioName(slug)/voiceprintId → 显示名（字幕回调的 voiceprintName 是注册时的 AudioName）
  const speakerNamesRef = useRef<Map<string, string>>(new Map());
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needTapToPlay, setNeedTapToPlay] = useState(false);
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>('idle');
  const [roomId, setRoomId] = useState<string | null>(null);

  /** 解析火山二进制消息（状态 + 字幕）→ 更新 store。 */
  const handleBinary = useCallback(
    (event: { userId: string; message: ArrayBuffer }) => {
      try {
        const { type, value } = tlv2String(event.message);
        if (type === MSG_BRIEF) {
          const code = JSON.parse(value)?.Stage?.Code;
          if (code === AGENT_BRIEF.THINKING) setVoiceStatus('thinking');
          else if (code === AGENT_BRIEF.SPEAKING) setVoiceStatus('speaking');
          else if (code === AGENT_BRIEF.LISTENING || code === AGENT_BRIEF.FINISHED || code === AGENT_BRIEF.INTERRUPTED)
            setVoiceStatus('listening');
        } else if (type === MSG_SUBTITLE) {
          const data = JSON.parse(value)?.data?.[0];
          const myId = sessionRef.current?.userId;
          if (data?.text && data.userId) {
            if (data.userId === myId) {
              // 声纹识别命中时字幕带 voiceprintName(=AudioName slug)/voiceprintId → 映射显示名
              const key = data.voiceprintName || data.voiceprintId;
              const speakerName = key ? speakerNamesRef.current.get(String(key)) : undefined;
              setUserSubtitle(data.text, speakerName); // 用户说的（ASR 转写）
            } else {
              setSubtitle(data.text); // 助手说的
            }
          }
        }
      } catch {
        /* tlv/json 解析异常忽略 */
      }
    },
    [setVoiceStatus, setSubtitle, setUserSubtitle],
  );

  const start = useCallback(
    async (opts?: { systemPrompt?: string; userId?: string }) => {
      if (engineRef.current || connecting) return;
      setConnecting(true);
      setConnectPhase('starting');
      setError(null);
      setNeedTapToPlay(false);
      try {
        const res = await apiFetch('/api/rtc/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(opts?.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
            ...(opts?.userId ? { userId: opts.userId } : {}),
          }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          appId: string;
          roomId: string;
          userId: string;
          token: string;
          taskId: string;
        };
        if (!data.ok) throw new Error(data.error || '起 AI 失败');
        sessionRef.current = { roomId: data.roomId, taskId: data.taskId, userId: data.userId };
        setRoomId(data.roomId);

        // 拉声纹名册（AudioName/voiceprintId → 显示名），字幕署名用；失败不阻塞（署名回退"你"）
        void apiFetch('/api/voiceprint/list')
          .then((r) => r.json())
          .then((d: { voiceprints?: Array<{ audioName: string; voiceprintId: string; displayName: string }> }) => {
            const map = speakerNamesRef.current;
            map.clear();
            for (const v of d.voiceprints ?? []) {
              map.set(v.audioName, v.displayName);
              map.set(v.voiceprintId, v.displayName);
            }
          })
          .catch(() => {});

        setConnectPhase('loading'); // 动态 import 12MB SDK，首次最慢
        const rtcMod: any = await import('@volcengine/rtc'); // eslint-disable-line @typescript-eslint/no-explicit-any
        const VERTC = rtcMod.default;
        const { MediaType, RoomProfileType } = rtcMod;
        vertcRef.current = VERTC;
        streamIndexMainRef.current = rtcMod.StreamIndex?.STREAM_INDEX_MAIN ?? 0;
        const engine = VERTC.createEngine(data.appId);
        engineRef.current = engine;

        engine.on(VERTC.events.onRoomBinaryMessageReceived, handleBinary as never);
        engine.on(VERTC.events.onAutoplayFailed, ((e: { userId?: string }) => {
          if (e?.userId) failedUsersRef.current.add(e.userId);
          setNeedTapToPlay(true);
        }) as never);

        setConnectPhase('joining');
        await engine.joinRoom(
          data.token,
          data.roomId,
          { userId: data.userId, extraInfo: JSON.stringify({ call_scene: 'RTC-AIGC', user_id: data.userId }) },
          { isAutoPublish: true, isAutoSubscribeAudio: true, roomProfileType: RoomProfileType.chat },
        );
        // 进房成功即视为连上（不等麦克风采集，避免权限弹窗卡住 UI / 开场白）
        // （曾有 setPlaybackVolume(60) 压播放音量——P003 儿童场景遗留，Javis 不需要，且加剧
        //   "TTS 忽大忽小"体感，已移除=默认 100%。）
        setConnected(true);
        setConnecting(false);
        setConnectPhase('idle');
        setVoiceStatus('listening');

        // 采麦 + 发布（异步，权限慢/失败不阻塞连接与开口）
        engine
          .startAudioCapture()
          .then(() => engine.publishStream(MediaType.AUDIO))
          .catch((e: Error) => {
            console.log('[rtc] mic fail:', e?.message);
            setError('麦克风没打开——检查麦克风权限后重试');
          });
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
        const engine = engineRef.current;
        if (engine) {
          try {
            await engine.leaveRoom();
          } catch {
            /* ignore */
          }
          vertcRef.current?.destroyEngine?.(engine);
          engineRef.current = null;
        }
        setConnected(false);
        setVoiceStatus('idle');
        setConnecting(false);
        setConnectPhase('idle');
      }
    },
    [connecting, handleBinary, setVoiceStatus],
  );

  /** autoplay 被浏览器拦时，用户手势内恢复播放 AI 音频。 */
  const resumePlay = useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      for (const uid of failedUsersRef.current) {
        try {
          engine.play?.(uid);
        } catch {
          /* ignore */
        }
      }
      failedUsersRef.current.clear();
    }
    setNeedTapToPlay(false);
  }, []);

  const stop = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.stopAudioCapture();
      } catch {
        /* ignore */
      }
      try {
        await engine.leaveRoom();
      } catch {
        /* ignore */
      }
      vertcRef.current?.destroyEngine?.(engine);
      engineRef.current = null;
    }
    const sess = sessionRef.current;
    if (sess) {
      void apiFetch('/api/rtc/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: sess.roomId, taskId: sess.taskId }),
      }).catch(() => {});
      sessionRef.current = null;
    }
    failedUsersRef.current.clear();
    setConnected(false);
    setConnecting(false);
    setConnectPhase('idle');
    setNeedTapToPlay(false);
    setRoomId(null);
    setVoiceStatus('idle');
    setSubtitle('');
    setUserSubtitle('');
  }, [setVoiceStatus, setSubtitle, setUserSubtitle]);

  const getAudioTrack = useCallback((kind: 'local' | 'remote'): MediaStreamTrack | undefined => {
    const engine = engineRef.current;
    const streamIndexMain = streamIndexMainRef.current;
    if (!engine || streamIndexMain === null) return undefined;
    try {
      const track: MediaStreamTrack | undefined =
        kind === 'local'
          ? engine.getLocalStreamTrack(streamIndexMain, 'audio')
          : engine.getRemoteStreamTrack(BOT_USER_ID, streamIndexMain, 'audio');
      return track && track.readyState === 'live' ? track : undefined;
    } catch {
      return undefined;
    }
  }, []);

  const setMicMuted = useCallback((muted: boolean) => {
    const engine = engineRef.current;
    const streamIndexMain = streamIndexMainRef.current;
    if (!engine || streamIndexMain === null) return;
    try {
      engine.setCaptureVolume(streamIndexMain, muted ? 0 : 100);
      console.log(`[guard] mic ${muted ? 'muted' : 'unmuted'}`);
    } catch (e) {
      console.log('[guard] setCaptureVolume failed:', (e as Error)?.message);
    }
  }, []);

  return { connected, connecting, connectPhase, error, needTapToPlay, roomId, start, stop, resumePlay, getAudioTrack, setMicMuted };
}
