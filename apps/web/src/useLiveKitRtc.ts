import { useCallback, useRef, useState } from 'react';
import { useAppStore } from './store';
import { apiFetch } from './api';
import { startVisionProbe } from './vision-bridge';
import { scheduleRefine } from './useMemoryRefine';
import type { ConnectPhase, UseVoiceRtc } from './useVoiceRtc';

/**
 * 自研语音链路 Hook（双引擎对比，2026-07-15）——与 useVoiceRtc 完全同构的接口，
 * App 经 useVoiceSession 外观按设置选用，UI 零感知差异。
 *
 * 链路：start() → POST /api/voice-engine/token 拿一次性接入凭据 → 动态 import SDK
 * （code-split 对齐 benchmark 侧）→ Room.connect。跨境弱网：直连失败自动切中转重试
 * 一次并记住（localStorage），下次直接走中转——移植自研测试页久经验证的降级逻辑。
 *
 * 对外 roomId 恒为 null：声纹注册/vault 上行/音乐报幕等 benchmark 会话专属能力在
 * 本引擎下自然静默（它们以 roomId 为会话信号）。已知差异：音乐守护 save 模式下
 * 唤醒会失败回守护态（依赖 benchmark 会话 API），对比实验场景可接受。
 */

type LiveKitModule = typeof import('livekit-client');
type Room = import('livekit-client').Room;
type RemoteParticipant = import('livekit-client').RemoteParticipant;

const RELAY_KEY = 'jv_lk_relay';
const wantRelay = (): boolean => {
  try {
    return localStorage.getItem(RELAY_KEY) === '1';
  } catch {
    return false;
  }
};
const rememberRelay = (): void => {
  try {
    localStorage.setItem(RELAY_KEY, '1');
  } catch {
    /* ignore */
  }
};

/** 自研 agent 状态 → store voiceStatus（initializing 等就绪前状态归入 listening）。 */
const AGENT_STATE_MAP: Record<string, 'listening' | 'thinking' | 'speaking'> = {
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  initializing: 'listening',
  idle: 'listening',
};

export function useLiveKitRtc(): UseVoiceRtc {
  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setUserSubtitle = useAppStore((s) => s.setUserSubtitle);

  const roomRef = useRef<Room | null>(null);
  const lkRef = useRef<LiveKitModule | null>(null);
  const genRef = useRef(0); // 代际守卫：stop/新 start 递增，在途 start 的每个 await 后校验（防挂起窗竞态泄漏）
  const audioElsRef = useRef<HTMLMediaElement[]>([]);
  // 重连退避（2026-07-16 OOM 雪球治本件之二）：连接失败/远端异常断后指数冷却
  // （2s→4s→8s→15s 封顶，成功清零）——服务端限单并发下，狂点重试只会反复被拒，
  // 客户端退避把重连风暴消灭在源头；主动挂断不计入。
  const failCountRef = useRef(0);
  const cooldownUntilRef = useRef(0);

  const noteFailure = useCallback(() => {
    failCountRef.current += 1;
    const backoffMs = Math.min(2000 * 2 ** (failCountRef.current - 1), 15000);
    cooldownUntilRef.current = Date.now() + backoffMs;
  }, []);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needTapToPlay, setNeedTapToPlay] = useState(false);
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>('idle');

  const detachAudio = useCallback(() => {
    for (const el of audioElsRef.current) {
      try {
        el.remove();
      } catch {
        /* ignore */
      }
    }
    audioElsRef.current = [];
  }, []);

  /** 本地清态（不触发远端操作）；主动 stop 与远端 Disconnected 共用。 */
  const cleanup = useCallback(() => {
    detachAudio();
    roomRef.current = null;
    setConnected(false);
    setConnecting(false);
    setConnectPhase('idle');
    setNeedTapToPlay(false);
    setVoiceStatus('idle');
    setSubtitle('');
    setUserSubtitle('');
  }, [detachAudio, setVoiceStatus, setSubtitle, setUserSubtitle]);

  const findAgent = useCallback((room: Room): RemoteParticipant | undefined => {
    const remotes = [...room.remoteParticipants.values()];
    return remotes.find((p) => p.isAgent) ?? remotes[0];
  }, []);

  /** Room 事件绑定（字幕/状态/音频/播放策略/断线）。 */
  const bindRoomEvents = useCallback(
    (room: Room, lk: LiveKitModule, myGen: number) => {
      const { RoomEvent, Track } = lk;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.autoplay = true;
          document.body.appendChild(el);
          audioElsRef.current.push(el);
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const el of track.detach()) {
          try {
            el.remove();
          } catch {
            /* ignore */
          }
          audioElsRef.current = audioElsRef.current.filter((x) => x !== el);
        }
      });

      // 字幕：句级替换，对齐 benchmark 语义——最新分句直接刷新当前字幕。
      // （0.18.0 曾按聊天气泡语义做轮内累积，单条字幕越滚越长不刷新——川哥真机反馈修正。）
      room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        if (myGen !== genRef.current) return;
        const latest = segments[segments.length - 1];
        if (!latest?.text) return;
        if (participant?.isAgent) setSubtitle(latest.text);
        else setUserSubtitle(latest.text); // 自研侧说话人识别在服务端 prompt 层，字幕不署名
      });

      // AI 状态（听/想/说）：agent participant attributes
      const applyAgentState = (p: RemoteParticipant) => {
        if (myGen !== genRef.current || !p.isAgent) return;
        const st = p.attributes?.['lk.agent.state'];
        const mapped = st ? AGENT_STATE_MAP[st] : undefined;
        if (mapped) setVoiceStatus(mapped);
      };
      room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => applyAgentState(p as RemoteParticipant));
      room.on(RoomEvent.ParticipantConnected, (p) => applyAgentState(p));

      // 自动播放被拦（WKWebView/浏览器策略）→ 提示点按恢复
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (myGen !== genRef.current) return;
        setNeedTapToPlay(!room.canPlaybackAudio);
      });

      // 断线：中断时记住走中转（下次连接直接中转）；彻底断开（含自研侧挂断即删房）→ 清态
      room.on(RoomEvent.Reconnecting, () => {
        rememberRelay();
      });
      room.on(RoomEvent.Disconnected, () => {
        if (myGen !== genRef.current) return; // 主动 stop 已递增代际，避免双清理（主动挂断不计退避）
        genRef.current++;
        noteFailure(); // 远端异常断（拒接/删房/网络死）→ 进冷却，防立即重连风暴
        cleanup();
      });
    },
    [cleanup, setVoiceStatus, setSubtitle, setUserSubtitle],
  );

  const start = useCallback(
    async (_opts?: { systemPrompt?: string; userId?: string }) => {
      if (roomRef.current || connecting) return;
      const waitMs = cooldownUntilRef.current - Date.now();
      if (waitMs > 0) {
        setError(`链路恢复中，${Math.ceil(waitMs / 1000)} 秒后再试`);
        return;
      }
      const myGen = ++genRef.current;
      setConnecting(true);
      setConnectPhase('starting');
      setError(null);
      setNeedTapToPlay(false);
      try {
        const res = await apiFetch('/api/voice-engine/token', { method: 'POST' });
        const data = (await res.json()) as { ok: boolean; error?: string; url: string; token: string; roomName: string };
        if (!data.ok) throw new Error(data.error || '起自研链路失败');
        if (myGen !== genRef.current) return;

        setConnectPhase('loading');
        const lk = await import('livekit-client');
        lkRef.current = lk;
        if (myGen !== genRef.current) return;

        setConnectPhase('joining');
        // 直连→中转两段尝试（已记住中转则直接中转）；每段新建 Room 实例保证事件/状态干净
        const attempts: Array<'direct' | 'relay'> = wantRelay() ? ['relay'] : ['direct', 'relay'];
        let room: Room | null = null;
        for (let i = 0; i < attempts.length; i++) {
          const mode = attempts[i]!;
          // audioCaptureDefaults 显式锁定（2026-07-17 降噪快赢1）：此前走 livekit-client
          // 默认（大概率开但未确认）；显式声明后 AEC/降噪/AGC 不随库升级或 WebView 默认漂移。
          const candidate = new lk.Room({
            adaptiveStream: true,
            dynacast: true,
            audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          bindRoomEvents(candidate, lk, myGen);
          try {
            await candidate.connect(
              data.url,
              data.token,
              mode === 'relay' ? { rtcConfig: { iceTransportPolicy: 'relay' } } : undefined,
            );
            if (mode === 'relay') rememberRelay();
            room = candidate;
            break;
          } catch (e) {
            try {
              await candidate.disconnect();
            } catch {
              /* ignore */
            }
            if (i === attempts.length - 1) throw e;
          }
        }
        if (!room) throw new Error('连接失败');
        if (myGen !== genRef.current) {
          // start 已被叫停：拆刚建的连接（对称回滚）
          void room.disconnect();
          return;
        }
        roomRef.current = room;
        // dev-only 调试钩子：E2E 可经 window 注入合成音频轨（生产 build 不含）
        if (import.meta.env.DEV) (window as unknown as { __lkRoom?: Room }).__lkRoom = room;

        setConnected(true);
        setConnecting(false);
        setConnectPhase('idle');
        setVoiceStatus('listening');
        failCountRef.current = 0; // 连接成功，退避清零
        cooldownUntilRef.current = 0;

        // 视觉常开幂等兜底（对齐 benchmark 侧行为）
        void startVisionProbe();

        // 开麦（用户手势栈内，顺带解锁 AudioContext）；失败不阻塞连接（agent 开场白仍可听）
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch (e) {
          console.log('[lk] mic fail:', (e as Error)?.message);
          setError('麦克风没打开——检查麦克风权限后重试');
        }
      } catch (e) {
        if (myGen === genRef.current) {
          setError((e as Error)?.message ?? String(e));
          noteFailure(); // 连接失败进冷却
          cleanup();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connecting, cleanup, setVoiceStatus, bindRoomEvents, noteFailure],
  );

  const stop = useCallback(async () => {
    genRef.current++; // 叫停在途 start
    scheduleRefine(); // 通话结束提炼调度（本机 vault 无待办时是 no-op，与 benchmark 侧对齐）
    const room = roomRef.current;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        /* ignore */
      }
    }
    cleanup();
  }, [cleanup]);

  const resumePlay = useCallback(() => {
    const room = roomRef.current;
    if (room) {
      void room
        .startAudio()
        .then(() => setNeedTapToPlay(false))
        .catch(() => {
          /* 保持提示，用户可再点 */
        });
    } else {
      setNeedTapToPlay(false);
    }
  }, []);

  const getAudioTrack = useCallback(
    (kind: 'local' | 'remote'): MediaStreamTrack | undefined => {
      const room = roomRef.current;
      const lk = lkRef.current;
      if (!room || !lk) return undefined;
      try {
        let track: MediaStreamTrack | undefined;
        if (kind === 'local') {
          track = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack;
        } else {
          const agent = findAgent(room);
          for (const pub of agent?.trackPublications.values() ?? []) {
            if (pub.kind === lk.Track.Kind.Audio && pub.track) {
              track = pub.track.mediaStreamTrack;
              break;
            }
          }
        }
        return track && track.readyState === 'live' ? track : undefined;
      } catch {
        return undefined;
      }
    },
    [findAgent],
  );

  const setMicMuted = useCallback((muted: boolean) => {
    const room = roomRef.current;
    if (!room) return;
    room.localParticipant
      .setMicrophoneEnabled(!muted)
      .then(() => console.log(`[lk-guard] mic ${muted ? 'muted' : 'unmuted'}`))
      .catch((e: Error) => console.log('[lk-guard] setMicrophoneEnabled failed:', e?.message));
  }, []);

  return {
    connected,
    connecting,
    connectPhase,
    error,
    needTapToPlay,
    roomId: null, // 恒 null：benchmark 会话专属能力（声纹/vault/报幕）自然静默
    start,
    stop,
    resumePlay,
    getAudioTrack,
    setMicMuted,
  };
}
