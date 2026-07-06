/**
 * 音乐播放器（独立音频通道 + 播放状态条）。
 *
 * - 房间激活时每 ~2s 轮询 /api/music/pending?roomId=（语音指令通道）
 * - 收到 play 指令：设置 src 并播放；控制条显示歌名 + 暂停/换一首/停止按钮（本地直控）
 * - 音量 = 目标音量 × min(speaking duck, guard duck)——bot 说话压低 + 唤醒态压低，取更低者
 * - 播放状态提升到 store（musicPlaying/musicTitle），useMusicGuard 靠它进出守护态
 * - <audio> 元素完全独立，不接入 RTC 音轨
 *
 * ⚠️ 轮询 effect 只依赖 [connected, roomId]，回调经 ref 桥接——绝不能把依赖
 * voiceStatus 的回调放进这个 effect 的依赖数组：bot 说话状态变化频繁，会导致
 * 轮询循环反复拆建、cleanup 里的 stopPlayback 把刚开始的音乐掐掉
 * （2026-07-05 v0.6.0 真机回归实锤：音乐响一瞬即停，听感"没响"）。
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { apiFetch } from '../api';

const POLL_MS = 2000;

interface PendingMusicCommand {
  action: 'play';
  streamUrl: string;
  title: string;
}

interface PendingControlCommand {
  action: 'control';
  control: string;
}

type PendingCommand = PendingMusicCommand | PendingControlCommand;

export function MusicPlayer({ roomId, connected }: { roomId: string | null; connected: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const musicDuck = useAppStore((s) => s.musicDuck);
  const setMusicPlaying = useAppStore((s) => s.setMusicPlaying);
  const targetVolumeRef = useRef(1.0);
  const lastCommandTsRef = useRef(0);
  const titleRef = useRef(''); // audio 事件读它（闭包不过期）
  const [track, setTrack] = useState<{ title: string } | null>(null);
  const [paused, setPaused] = useState(false);
  const [switching, setSwitching] = useState(false);

  // —— 音量：普通函数 + 单独 effect 响应 duck 来源变化（不进轮询依赖）——
  function applyVolume() {
    const audio = audioRef.current;
    if (!audio) return;
    const speakingDuck = useAppStore.getState().voiceStatus === 'speaking' ? 0.3 : 1.0;
    const guardDuck = useAppStore.getState().musicDuck;
    audio.volume = Math.max(0, Math.min(1, targetVolumeRef.current * Math.min(speakingDuck, guardDuck)));
  }

  useEffect(() => {
    applyVolume();
  }, [voiceStatus, musicDuck]);

  function setTargetVolume(v: number) {
    targetVolumeRef.current = Math.max(0.1, Math.min(1, v));
    applyVolume();
  }

  function stopPlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.src = '';
    } catch {
      /* */
    }
    titleRef.current = '';
    setTrack(null);
    setPaused(false);
    setMusicPlaying(false);
  }

  function handleCommand(cmd: PendingCommand) {
    const audio = audioRef.current;
    if (!audio) return;

    if (cmd.action === 'play') {
      const { streamUrl, title } = cmd;
      console.log(`[music] play "${title}" url=${streamUrl.slice(0, 80)}`);
      try {
        audio.pause();
      } catch {
        /* */
      }
      audio.src = streamUrl;
      titleRef.current = title;
      setTrack({ title });
      setPaused(false);
      void audio.play().catch((e) => {
        console.log('[music] play() blocked or failed:', (e as Error)?.message);
      });
      applyVolume();
      return;
    }

    if (cmd.action === 'control') {
      const c = cmd.control;
      if (c === 'pause') {
        audio.pause();
      } else if (c === 'resume') {
        void audio.play().catch(() => {});
      } else if (c === 'louder') {
        setTargetVolume(targetVolumeRef.current + 0.2);
      } else if (c === 'quieter') {
        setTargetVolume(targetVolumeRef.current - 0.2);
      } else if (c === 'prev') {
        // MVP：回到本曲开头
        audio.currentTime = 0;
      }
      applyVolume();
    }
  }

  // ref 桥：轮询/清理永远调用最新实现，effect 依赖保持最小
  const handleCommandRef = useRef(handleCommand);
  handleCommandRef.current = handleCommand;
  const stopPlaybackRef = useRef(stopPlayback);
  stopPlaybackRef.current = stopPlayback;

  /** 换歌/回上一首共用：按钮与 KWS 控制词直调 server，同步返回新歌不等轮询。 */
  async function switchTrack(endpoint: '/api/music/next' | '/api/music/prev') {
    if (!roomId || switching) return;
    setSwitching(true);
    try {
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      });
      const d = (await res.json()) as { ok?: boolean; command?: PendingMusicCommand; error?: string };
      if (d.ok && d.command) {
        handleCommand(d.command);
      } else {
        console.log(`[music] ${endpoint} failed:`, d.error);
      }
    } catch (e) {
      console.log(`[music] ${endpoint} error:`, (e as Error)?.message);
    } finally {
      setSwitching(false);
    }
  }
  const nextTrack = () => switchTrack('/api/music/next');
  const prevTrack = () => switchTrack('/api/music/prev');

  /** KWS 本地控制词（useMusicGuard 分流投递）：守护态 mic 对火山静音，控制不经语音链路。 */
  function handleLocalControl(action: string) {
    const audio = audioRef.current;
    console.log(`[music] local-control ${action}`);
    if (action === 'next') void nextTrack();
    else if (action === 'prev') void prevTrack();
    else if (action === 'pause') audio?.pause();
    else if (action === 'stop') stopPlayback();
  }
  const handleLocalControlRef = useRef(handleLocalControl);
  handleLocalControlRef.current = handleLocalControl;
  useEffect(() => {
    const h = (e: Event) =>
      handleLocalControlRef.current((e as CustomEvent<{ action?: string }>).detail?.action ?? '');
    window.addEventListener('music-local-control', h);
    return () => window.removeEventListener('music-local-control', h);
  }, []);

  // audio 原生事件 → store（guard 的唯一事实源）。挂载一次，title 走 ref 不过期。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => {
      setPaused(false);
      setMusicPlaying(true, titleRef.current);
    };
    const onPause = () => {
      setPaused(true);
      setMusicPlaying(false);
    };
    const onEnded = () => {
      setPaused(false);
      titleRef.current = '';
      setTrack(null);
      setMusicPlaying(false);
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 轮询 pending（仅房间激活时）。依赖严格 [connected, roomId]——见文件头 ⚠️。
  useEffect(() => {
    if (!connected || !roomId) return;

    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await apiFetch(`/api/music/pending?roomId=${encodeURIComponent(roomId)}`);
        const data = (await res.json()) as { command?: PendingCommand | null };
        const cmd = data.command;
        if (cmd) {
          const now = Date.now();
          if (now - lastCommandTsRef.current > 800) {
            lastCommandTsRef.current = now;
            handleCommandRef.current(cmd);
          }
        }
      } catch {
        /* 轮询失败静默，下一轮重试 */
      }
    };

    const timer = setInterval(() => void poll(), POLL_MS);
    void poll();

    return () => {
      stopped = true;
      clearInterval(timer);
      stopPlaybackRef.current(); // 离开房间清理播放
    };
  }, [connected, roomId]);

  const audio = audioRef.current;

  return (
    <>
      {track && (
        <div style={styles.wrap}>
          <div style={styles.bar}>
            <span style={styles.note}>♪</span>
            <span style={styles.title} title={track.title}>
              {track.title}
            </span>
            <button style={styles.ctl} disabled={switching} onClick={() => void prevTrack()} title="上一首">
              ⏮
            </button>
            <button
              style={styles.ctl}
              onClick={() => {
                if (!audio) return;
                if (paused) void audio.play().catch(() => {});
                else audio.pause();
              }}
            >
              {paused ? '▶' : '⏸'}
            </button>
            <button style={styles.ctl} disabled={switching} onClick={() => void nextTrack()} title="下一首">
              {switching ? '…' : '⏭'}
            </button>
            <button style={styles.ctl} onClick={stopPlayback} title="停止">
              ⏹
            </button>
          </div>
        </div>
      )}
      <audio ref={audioRef} style={{ display: 'none' }} />
    </>
  );
}

// 播放条与 #04060c 背景融合（川哥 2026-07-06 拍板）：无边框无底色胶囊，
// 紧贴脉冲球下方（位置由 App.tsx 决定），只留歌名 + 控制按钮的淡色浮层感。
const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', justifyContent: 'center', width: '100%' },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '2px 12px',
    color: '#8b96b3',
    fontSize: 13,
    maxWidth: 520,
  },
  note: { fontSize: 15, color: '#93c5fd' },
  title: {
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  ctl: {
    border: 'none',
    background: 'transparent',
    color: '#aab6d4',
    borderRadius: 999,
    width: 32,
    height: 32,
    cursor: 'pointer',
    fontSize: 15,
    lineHeight: 1,
  },
};
