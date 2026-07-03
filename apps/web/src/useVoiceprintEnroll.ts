/**
 * 声纹「对话式注册」前端编排：通话中轮询 server 的 pending 注册会话，
 * 发现 recording → 从 RTC 麦克风轨旁路录音（VoiceprintRecorder）→ 录满自动上传。
 *
 * 全程零 UI 操作：用户说「我是X，记住我」→ Javis 引导陪聊 → 这里静默录满 → 上传 →
 * 成败播报由 server 经 ExternalTextToSpeech 完成；失败可重试时 server 把会话拨回
 * recording，下一轮轮询自然重新开录。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';
import { VoiceprintRecorder } from './voiceprintRecorder';

const POLL_MS = 2500;

export interface EnrollStatus {
  displayName: string;
  state: 'awaiting_name' | 'recording' | 'uploading' | 'done' | 'failed';
  effectiveSec: number;
  targetSec: number;
}

interface PendingPayload {
  displayName: string;
  state: 'awaiting_name' | 'recording' | 'done' | 'failed';
  attempt: number;
}

export function useVoiceprintEnroll(args: {
  connected: boolean;
  roomId: string | null;
  getAudioTrack: (kind: 'local' | 'remote') => MediaStreamTrack | undefined;
}): EnrollStatus | null {
  const { connected, roomId, getAudioTrack } = args;
  const [status, setStatus] = useState<EnrollStatus | null>(null);
  const recorderRef = useRef<VoiceprintRecorder | null>(null);
  const uploadingRef = useRef(false); // register 请求飞行期间轮询仍见 recording，防重复开录
  const pendingNameRef = useRef('');

  useEffect(() => {
    if (!connected || !roomId) return;

    const cleanupRecorder = (): void => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };

    const upload = async (wavBase64: string): Promise<void> => {
      uploadingRef.current = true;
      setStatus((s) => (s ? { ...s, state: 'uploading' } : s));
      try {
        await apiFetch('/api/voiceprint/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: pendingNameRef.current, wavBase64, roomId }),
        });
        // 成败与重试话术均由 server 播报并更新 pending 状态；这里只等下一轮轮询对齐
      } catch (err) {
        console.log('[enroll] upload failed:', (err as Error).message);
      } finally {
        uploadingRef.current = false;
        recorderRef.current = null;
      }
    };

    const startRecording = (displayName: string): void => {
      const track = getAudioTrack('local');
      if (!track) return; // 麦克风轨未就绪（权限慢），下一轮轮询再试
      const recorder = new VoiceprintRecorder(
        (p) =>
          setStatus({
            displayName: pendingNameRef.current,
            state: 'recording',
            effectiveSec: p.effectiveSec,
            targetSec: p.targetEffectiveSec,
          }),
        (r) => void upload(r.wavBase64),
        (err) => {
          console.log('[enroll] recorder error:', err.message);
          recorderRef.current = null;
        },
      );
      recorderRef.current = recorder;
      recorder.start(track);
      setStatus({ displayName, state: 'recording', effectiveSec: 0, targetSec: 14 });
    };

    const poll = async (): Promise<void> => {
      try {
        const res = await apiFetch(`/api/voiceprint/pending?room=${encodeURIComponent(roomId)}`);
        const data = (await res.json()) as { ok: boolean; pending: PendingPayload | null };
        const pending = data.pending;
        if (!pending) {
          cleanupRecorder();
          setStatus(null);
          return;
        }
        pendingNameRef.current = pending.displayName; // 录音中改口换名，上传用最新名字
        if (pending.state === 'recording') {
          if (!recorderRef.current && !uploadingRef.current) startRecording(pending.displayName);
        } else {
          cleanupRecorder();
          setStatus({ displayName: pending.displayName, state: pending.state, effectiveSec: 0, targetSec: 14 });
        }
      } catch {
        /* 轮询失败静默，下一轮重试 */
      }
    };

    const timer = setInterval(() => void poll(), POLL_MS);
    void poll();
    return () => {
      clearInterval(timer);
      cleanupRecorder();
      setStatus(null);
    };
  }, [connected, roomId, getAudioTrack]);

  return status;
}
