/**
 * 音乐×助手共存的守护状态机（DESIGN-coexistence.md §8 步 2 的 coordinator）。
 *
 * 三态：
 *  - idle    ：无音乐，正常全双工对话。
 *  - guarded ：音乐播放中。上行麦克风静音/AI 任务暂停——音乐随便放，火山听不到
 *              任何东西（歌词零误触发、对话零被搅）。代价：语音唤醒不可用，
 *              点击律动球（PTT 兜底）唤醒；步 3 KWS 上线后由"贾维斯"唤醒词替代。
 *  - active  ：唤醒态。音乐 duck 到 20%，上行恢复，正常对话若干轮；
 *              bot 说完后 8 秒无后续对话自动回 guarded（追问窗口）。
 *
 * 计费模式（D1 拍板 C：开关双实现，默认省钱；server 下发，改模式不用重发 App）：
 *  - respond：守护= setCaptureVolume(0)（任务挂着收静音帧，唤醒零延迟，持续计费）。
 *  - save   ：守护= server StopVoiceChat 停任务（零空转计费；唤醒 resume-agent 重启任务
 *             ~2s 才能说话，播确认音掩盖；对话 history 随任务丢失=省钱模式固有代价）。
 *
 * 铁律（呼应 detector 互斥矩阵教训）：duck/mute/任务停启只由本状态机决策，
 * LLM/播放器/RTC 各自不得直接碰这些底层音频状态。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from './store';
import { apiFetch } from './api';
import { kwsStart, kwsStop, onKwsWake } from './kws-bridge';

export type GuardState = 'idle' | 'guarded' | 'active';
export type GuardMode = 'respond' | 'save';

const DUCK_LEVEL = 0.2; // 唤醒态音乐音量系数
const FOLLOWUP_WINDOW_MS = 8000; // bot 说完后的追问窗口，超时回 guarded

/** 唤醒确认音：两个短纯音上行音阶（手势栈内调用，无 autoplay 问题；零资产文件）。 */
function playChime(): void {
  try {
    const AC = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const play = (freq: number, at: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.05);
    };
    play(880, 0, 0.12);
    play(1318, 0.1, 0.16);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* 提示音失败不阻塞唤醒 */
  }
}

export function useMusicGuard(args: {
  connected: boolean;
  roomId: string | null;
  setMicMuted: (muted: boolean) => void;
}): { guardState: GuardState; guardMode: GuardMode; wake: () => void; waking: boolean } {
  const { connected, roomId, setMicMuted } = args;
  const musicPlaying = useAppStore((s) => s.musicPlaying);
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);
  const setMusicDuck = useAppStore((s) => s.setMusicDuck);

  const [guardState, setGuardState] = useState<GuardState>('idle');
  const [guardMode, setGuardMode] = useState<GuardMode>('save');
  const [waking, setWaking] = useState(false);
  const followupTimer = useRef<number | null>(null);
  const roomIdRef = useRef<string | null>(null);
  roomIdRef.current = roomId;

  // 连接后拉一次计费模式配置（server env MUSIC_GUARD_MODE 下发，默认 save）
  useEffect(() => {
    if (!connected) return;
    void apiFetch('/api/music/guard-config')
      .then((r) => r.json())
      .then((d: { mode?: string }) => setGuardMode(d.mode === 'respond' ? 'respond' : 'save'))
      .catch(() => {}); // 拉不到保持默认 save
  }, [connected]);

  /** 守护动作：静音上行（respond）或停 AI 任务（save）。 */
  const muteUplink = useCallback(
    (mode: GuardMode) => {
      if (mode === 'save') {
        const rid = roomIdRef.current;
        if (rid) {
          void apiFetch('/api/rtc/pause-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: rid }),
          }).catch((e) => console.log('[guard] pause-agent failed:', (e as Error)?.message));
        }
        // 任务停了 ASR 自然安静；本地采集音量同时置 0 做双保险（任务停失败时仍守护）
        setMicMuted(true);
      } else {
        setMicMuted(true);
      }
    },
    [setMicMuted],
  );

  /** 唤醒动作：恢复上行（respond 即时；save 需重启任务 ~2s）。返回是否成功。 */
  const unmuteUplink = useCallback(
    async (mode: GuardMode): Promise<boolean> => {
      if (mode === 'save') {
        const rid = roomIdRef.current;
        if (!rid) return false;
        try {
          const res = await apiFetch('/api/rtc/resume-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: rid }),
          });
          const d = (await res.json()) as { ok?: boolean; error?: string };
          if (!d.ok) {
            console.log('[guard] resume-agent failed:', d.error);
            return false;
          }
        } catch (e) {
          console.log('[guard] resume-agent error:', (e as Error)?.message);
          return false;
        }
        setMicMuted(false);
        return true;
      }
      setMicMuted(false);
      return true;
    },
    [setMicMuted],
  );

  const clearFollowupTimer = useCallback(() => {
    if (followupTimer.current !== null) {
      window.clearTimeout(followupTimer.current);
      followupTimer.current = null;
    }
  }, []);

  /** PTT 唤醒（点击律动球触发；步 3 KWS 命中走同一入口）。 */
  const wake = useCallback(() => {
    if (guardState !== 'guarded' || waking) return;
    setWaking(true);
    playChime();
    setMusicDuck(DUCK_LEVEL); // 先 duck 再恢复听——用户接下来说的话更清晰
    void unmuteUplink(guardMode).then((ok) => {
      setWaking(false);
      if (ok) {
        setGuardState('active');
      } else {
        // 唤醒失败：恢复音量回守护态（用户可重试）
        setMusicDuck(1);
        console.log('[guard] wake failed, back to guarded');
      }
    });
  }, [guardState, waking, guardMode, unmuteUplink, setMusicDuck]);

  // 进入/退出守护：音乐开始（且 bot 说完报幕）→ guarded；音乐结束 → idle
  useEffect(() => {
    if (!connected) {
      // 断开连接：状态机复位（引擎已销毁，无需 unmute）
      clearFollowupTimer();
      setGuardState('idle');
      setMusicDuck(1);
      return;
    }
    if (musicPlaying && guardState === 'idle') {
      // 等 bot 说完"好，给你放《x》"再进守护（省钱模式停任务会掐断报幕；统一延迟无害）
      if (voiceStatus === 'listening' || voiceStatus === 'idle') {
        console.log(`[guard] enter guarded (mode=${guardMode})`);
        muteUplink(guardMode);
        setGuardState('guarded');
      }
      return;
    }
    if (!musicPlaying && guardState !== 'idle') {
      console.log('[guard] music ended → idle, restore uplink');
      clearFollowupTimer();
      void unmuteUplink(guardMode);
      setMusicDuck(1);
      setGuardState('idle');
    }
  }, [connected, musicPlaying, guardState, voiceStatus, guardMode, muteUplink, unmuteUplink, setMusicDuck, clearFollowupTimer]);

  // —— 贾维斯唤醒词（步 3，桌面壳 Rust KWS）：仅 guarded 态运行——惰性省 CPU，
  //    且 active/idle 态（有 TTS）不跑 KWS = 天然免"助手自己说出唤醒词自触发"。
  //    命中走 wake() 与点球 PTT 同一入口；wake 经 ref 桥接（effect 只依赖 guardState，
  //    学 v0.6.0 轮询拆建教训）。浏览器环境 kws-bridge 全部 no-op（只能点球）。
  const wakeRef = useRef(wake);
  wakeRef.current = wake;
  useEffect(() => {
    if (guardState !== 'guarded') return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void kwsStart();
    void onKwsWake((keyword) => {
      console.log(`[guard] kws-wake "${keyword}"`);
      wakeRef.current();
    }).then((u) => {
      if (disposed) u?.();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
      void kwsStop();
    };
  }, [guardState]);

  // active 态的追问窗口：bot 说完（listening）起 8s 计时，任何新对话活动重置；超时回 guarded
  useEffect(() => {
    if (guardState !== 'active') {
      clearFollowupTimer();
      return;
    }
    clearFollowupTimer();
    if (voiceStatus === 'listening') {
      followupTimer.current = window.setTimeout(() => {
        console.log('[guard] followup window timeout → back to guarded');
        muteUplink(guardMode);
        setMusicDuck(1);
        setGuardState('guarded');
      }, FOLLOWUP_WINDOW_MS);
    }
    // thinking/speaking = 对话进行中，不计时（等回到 listening 重新起表）
    return clearFollowupTimer;
    // subtitle/userSubtitle 变化也会重跑本 effect = 重置计时器（用户在说话/bot 在出字）
  }, [guardState, voiceStatus, subtitle, userSubtitle, guardMode, muteUplink, setMusicDuck, clearFollowupTimer]);

  return { guardState, guardMode, wake, waking };
}
