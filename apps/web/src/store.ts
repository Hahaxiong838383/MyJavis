import { create } from 'zustand';

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

interface AppState {
  voiceStatus: VoiceStatus;
  subtitle: string; // 助手说的（TTS 字幕）
  userSubtitle: string; // 用户说的（ASR 转写）
  speakerName: string; // 声纹识别出的当前说话人名（字幕回调 voiceprintName），空=未识别
  setVoiceStatus: (s: VoiceStatus) => void;
  setSubtitle: (t: string) => void;
  setUserSubtitle: (t: string, speakerName?: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  voiceStatus: 'idle',
  subtitle: '',
  userSubtitle: '',
  speakerName: '',
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setSubtitle: (subtitle) => set({ subtitle }),
  setUserSubtitle: (userSubtitle, speakerName) =>
    set((s) => ({ userSubtitle, speakerName: speakerName ?? (userSubtitle ? s.speakerName : '') })),
}));
