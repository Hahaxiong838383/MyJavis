/**
 * 记忆引导闭环（R3.5 方案A + 2026-07-08 川哥拍板扩展 solo）：
 * - 家庭模式（solo=false）+ 零声纹：记忆系统实际不工作（未识别的话全部暂存）→ ⚠️ 警示条
 * - 单人模式（solo=true）+ 零声纹：记忆开箱即用但声纹能让 Javis 听声认人（也服务后续
 *   降噪等扩展）→ 💡 温和引导条。注册第一条声纹后两种条都自动消失。
 *
 * 依赖两个域的 sync 事件：'memory'（soloMode 切换走 /api/me/config PUT 时 bump）+
 * 'voiceprint'（注册/删除声纹时 bump，见 voiceprint/registry.ts）。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';
import { useSyncRefresh } from './useSyncVersions';

export type MemoryGuidanceKind = 'family' | 'solo' | null;

export function useMemoryGuidanceBanner(): MemoryGuidanceKind {
  const [soloMode, setSoloMode] = useState<boolean | null>(null);
  const [voiceprintCount, setVoiceprintCount] = useState<number | null>(null);

  const loadConfig = async (): Promise<void> => {
    try {
      const data = (await apiFetch('/api/me/config').then((r) => r.json())) as { ok: boolean; me?: { soloMode: boolean } };
      if (data.ok && data.me) setSoloMode(data.me.soloMode);
    } catch {
      /* 网络抖动：状态条按上次已知状态显示，下轮 sync 再试 */
    }
  };
  const loadVoiceprints = async (): Promise<void> => {
    try {
      const data = (await apiFetch('/api/voiceprint/list').then((r) => r.json())) as {
        ok: boolean;
        voiceprints?: unknown[];
      };
      if (data.ok) setVoiceprintCount((data.voiceprints ?? []).length);
    } catch {
      /* 同上 */
    }
  };
  const loadConfigRef = useRef(loadConfig);
  loadConfigRef.current = loadConfig;
  const loadVoiceprintsRef = useRef(loadVoiceprints);
  loadVoiceprintsRef.current = loadVoiceprints;

  useEffect(() => {
    void loadConfigRef.current();
    void loadVoiceprintsRef.current();
  }, []);
  useSyncRefresh('memory', () => void loadConfigRef.current());
  useSyncRefresh('voiceprint', () => void loadVoiceprintsRef.current());

  if (voiceprintCount !== 0) return null;
  if (soloMode === false) return 'family';
  if (soloMode === true) return 'solo';
  return null; // 配置未加载完：不闪现
}
