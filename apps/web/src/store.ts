import { create } from 'zustand';

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

interface AppState {
  voiceStatus: VoiceStatus;
  subtitle: string; // 助手说的（TTS 字幕）
  userSubtitle: string; // 用户说的（ASR 转写）
  speakerName: string; // 声纹识别出的当前说话人名（字幕回调 voiceprintName），空=未识别
  // —— 音乐播放状态（MusicPlayer 写，useMusicGuard/UI 读）——
  musicPlaying: boolean;
  musicTitle: string;
  /** guard 写入的音乐 duck 系数（1=正常，0.2=唤醒态压低），MusicPlayer 消费。 */
  musicDuck: number;
  setVoiceStatus: (s: VoiceStatus) => void;
  setSubtitle: (t: string) => void;
  setUserSubtitle: (t: string, speakerName?: string) => void;
  setMusicPlaying: (playing: boolean, title?: string) => void;
  setMusicDuck: (v: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  voiceStatus: 'idle',
  subtitle: '',
  userSubtitle: '',
  speakerName: '',
  musicPlaying: false,
  musicTitle: '',
  musicDuck: 1,
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setSubtitle: (subtitle) => set({ subtitle }),
  setUserSubtitle: (userSubtitle, speakerName) =>
    set((s) => ({ userSubtitle, speakerName: speakerName ?? (userSubtitle ? s.speakerName : '') })),
  setMusicPlaying: (musicPlaying, title) =>
    set((s) => ({ musicPlaying, musicTitle: title !== undefined ? title : musicPlaying ? s.musicTitle : '' })),
  setMusicDuck: (musicDuck) => set({ musicDuck }),
}));
