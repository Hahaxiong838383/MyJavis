/**
 * 记忆引导闭环（R3.5 方案A）：家庭模式（solo=false）下还没有任何声纹注册时，
 * 记忆系统实际不工作（声纹未识别的话全部暂存不落库）——App 顶部状态条把这个
 * 隐藏事实变得可见可引导。solo=true 时记忆本来就开箱即用，不显示。
 *
 * 依赖两个域的 sync 事件：'memory'（soloMode 切换走 /api/me/config PUT 时 bump）+
 * 'voiceprint'（注册/删除声纹时 bump，见 voiceprint/registry.ts）。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';
import { useSyncRefresh } from './useSyncVersions';

export function useMemoryGuidanceBanner(): boolean {
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

  return soloMode === false && voiceprintCount === 0;
}
