/**
 * 音乐播放器（独立音频通道 + 播放状态条）。
 *
 * - 房间激活时每 ~2s 轮询 /api/music/pending?roomId=（语音指令通道）
 * - 收到 play 指令：设置 src 并播放；控制条显示歌名 + 暂停/换一首/停止按钮（本地直控）
 * - 音量 = 目标音量 × min(speaking duck, guard duck)——bot 说话压低 + 唤醒态压低，取更低者
 * - 播放状态提升到 store（musicPlaying/musicTitle），useMusicGuard 靠它进出守护态
 * - <audio> 元素完全独立，不接入 RTC 音轨
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [track, setTrack] = useState<{ title: string } | null>(null);
  const [paused, setPaused] = useState(false);
  const [switching, setSwitching] = useState(false);

  const applyVolume = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const speakingDuck = voiceStatus === 'speaking' ? 0.3 : 1.0;
    const duck = Math.min(speakingDuck, musicDuck);
    audio.volume = Math.max(0, Math.min(1, targetVolumeRef.current * duck));
  }, [voiceStatus, musicDuck]);

  // duck 来源变化（bot 说话/guard 唤醒态）即时生效
  useEffect(() => {
    applyVolume();
  }, [applyVolume]);

  function setTargetVolume(v: number) {
    targetVolumeRef.current = Math.max(0.1, Math.min(1, v));
    applyVolume();
  }

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.src = '';
    } catch {
      /* */
    }
    setTrack(null);
    setPaused(false);
    setMusicPlaying(false);
  }, [setMusicPlaying]);

  const handleCommand = useCallback(
    (cmd: PendingCommand) => {
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
    },
    [applyVolume],
  );

  /** 换一首（按钮/语音共用 server 端换歌逻辑：上次查询 + 排除已放）。 */
  const nextTrack = useCallback(async () => {
    if (!roomId || switching) return;
    setSwitching(true);
    try {
      const res = await apiFetch('/api/music/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      });
      const d = (await res.json()) as { ok?: boolean; command?: PendingMusicCommand; error?: string };
      if (d.ok && d.command) {
        handleCommand(d.command);
      } else {
        console.log('[music] next failed:', d.error);
      }
    } catch (e) {
      console.log('[music] next error:', (e as Error)?.message);
    } finally {
      setSwitching(false);
    }
  }, [roomId, switching, handleCommand]);

  // audio 原生事件 → store（guard 的唯一事实源）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => {
      setPaused(false);
      setMusicPlaying(true, track?.title ?? '');
    };
    const onPause = () => {
      setPaused(true);
      setMusicPlaying(false);
    };
    const onEnded = () => {
      setPaused(false);
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
  }, [track, setMusicPlaying]);

  // 轮询 pending（仅房间激活时）
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
            handleCommand(cmd);
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
      stopPlayback(); // 离开房间清理播放
    };
  }, [connected, roomId, handleCommand, stopPlayback]);

  const audio = audioRef.current;

  return (
    <>
      {track && (
        <div style={styles.bar}>
          <span style={styles.note}>♪</span>
          <span style={styles.title} title={track.title}>
            {track.title}
          </span>
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
          <button style={styles.ctl} disabled={switching} onClick={() => void nextTrack()}>
            {switching ? '…' : '⏭'}
          </button>
          <button style={styles.ctl} onClick={stopPlayback}>
            ⏹
          </button>
        </div>
      )}
      <audio ref={audioRef} style={{ display: 'none' }} />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 14px',
    borderRadius: 999,
    background: 'rgba(59,130,246,0.10)',
    border: '1px solid rgba(59,130,246,0.30)',
    color: '#93c5fd',
    fontSize: 13,
    maxWidth: 480,
  },
  note: { fontSize: 15 },
  title: {
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  ctl: {
    border: 'none',
    background: 'rgba(59,130,246,0.18)',
    color: '#bfdbfe',
    borderRadius: 999,
    width: 30,
    height: 30,
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
  },
};
