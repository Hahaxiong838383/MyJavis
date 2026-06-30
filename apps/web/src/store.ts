import { create } from 'zustand';

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

interface AppState {
  voiceStatus: VoiceStatus;
  subtitle: string; // 助手说的（TTS 字幕）
  userSubtitle: string; // 用户说的（ASR 转写）
  setVoiceStatus: (s: VoiceStatus) => void;
  setSubtitle: (t: string) => void;
  setUserSubtitle: (t: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  voiceStatus: 'idle',
  subtitle: '',
  userSubtitle: '',
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setSubtitle: (subtitle) => set({ subtitle }),
  setUserSubtitle: (userSubtitle) => set({ userSubtitle }),
}));
