/**
 * 音乐播放器（独立音频通道）。
 *
 * - 房间激活时每 ~2s 轮询 /api/music/pending?roomId=
 * - 收到 play 指令：设置 src 并播放
 * - 收到 control：pause/resume/volume 调整（next/prev MVP 忽略或暂停当前）
 * - 复用全局 voiceStatus：speaking 时 duck 到 0.3，非 speaking 恢复
 * - <audio> 元素完全独立，不接入 RTC 音轨
 */

import { useEffect, useRef } from 'react';
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
  const targetVolumeRef = useRef(1.0);
  const lastCommandTsRef = useRef(0);

  // 初始音量设置（DOM 元素挂载后）
  useEffect(() => {
    applyVolume();
  }, []);

  // 根据 voiceStatus 做 duck：speaking → 低音量，否则恢复用户目标音量
  useEffect(() => {
    applyVolume();
  }, [voiceStatus]);

  function applyVolume() {
    const audio = audioRef.current;
    if (!audio) return;
    const speaking = voiceStatus === 'speaking';
    const duck = speaking ? 0.3 : 1.0;
    const vol = Math.max(0, Math.min(1, targetVolumeRef.current * duck));
    audio.volume = vol;
  }

  function setTargetVolume(v: number) {
    targetVolumeRef.current = Math.max(0.1, Math.min(1, v));
    applyVolume();
  }

  function handleCommand(cmd: PendingCommand) {
    const audio = audioRef.current;
    if (!audio) return;

    if (cmd.action === 'play') {
      const { streamUrl, title } = cmd;
      console.log(`[music] play "${title}" url=${streamUrl}`);
      try {
        audio.pause();
      } catch {
        /* */
      }
      audio.src = streamUrl;
      // 尝试播放（RTC 环境通常已解锁 autoplay）
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
      } else if (c === 'next' || c === 'prev') {
        // MVP：简单暂停当前（用户可再用自然语言指定下一首具体歌名）
        audio.pause();
      }
      applyVolume();
    }
  }

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
          // 简单去重：同一指令短时间内不重复执行
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
    void poll(); // 立即首轮

    return () => {
      stopped = true;
      clearInterval(timer);
      // 离开房间清理播放
      const audio = audioRef.current;
      if (audio) {
        try {
          audio.pause();
          audio.src = '';
        } catch {
          /* */
        }
      }
    };
  }, [connected, roomId]);

  // 渲染隐藏的 <audio> 元素（独立通道，不接入 RTC）
  return <audio ref={audioRef} style={{ display: 'none' }} />;
}
