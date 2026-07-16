import { useEffect, useState } from 'react';
import { useVoiceRtc, type UseVoiceRtc } from './useVoiceRtc';
import { useLiveKitRtc } from './useLiveKitRtc';

/**
 * 语音会话外观（双引擎对比，2026-07-15）：按设置在 benchmark（默认链路）/ indie（自研链路）
 * 间切换，对 App 暴露与 UseVoiceRtc 同构的单一实例。
 *
 * - 两个引擎 hook 恒定调用（React hook 规则），仅当前引擎的实例被 UI 消费；
 * - 切换经 CustomEvent（SettingsPanel 发起）：先对两栈都执行 stop（幂等，未连接秒回）
 *   再改引擎——杜绝双活跃抢麦（切换时序红线）；
 * - 持久化 localStorage，重启 App 保持选择。UI 展示词统一「benchmark / 自研」。
 */

export type VoiceEngine = 'benchmark' | 'indie';

const ENGINE_KEY = 'jv_voice_engine';
export const ENGINE_EVENT = 'jv-voice-engine-changed';

export function voiceEngine(): VoiceEngine {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'indie' ? 'indie' : 'benchmark';
  } catch {
    return 'benchmark';
  }
}

/** SettingsPanel 调用：持久化 + 广播（App 侧外观 hook 收到后先挂断两栈再生效）。 */
export function requestEngineSwitch(engine: VoiceEngine): void {
  try {
    localStorage.setItem(ENGINE_KEY, engine);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(ENGINE_EVENT, { detail: engine }));
}

export function useVoiceSession(): UseVoiceRtc & { engine: VoiceEngine } {
  const benchmark = useVoiceRtc();
  const indie = useLiveKitRtc();
  const [engine, setEngine] = useState<VoiceEngine>(() => voiceEngine());

  const stopBenchmark = benchmark.stop;
  const stopIndie = indie.stop;
  useEffect(() => {
    const onSwitch = (ev: Event) => {
      const next: VoiceEngine = (ev as CustomEvent).detail === 'indie' ? 'indie' : 'benchmark';
      void Promise.allSettled([stopBenchmark(), stopIndie()]).then(() => setEngine(next));
    };
    window.addEventListener(ENGINE_EVENT, onSwitch);
    return () => window.removeEventListener(ENGINE_EVENT, onSwitch);
  }, [stopBenchmark, stopIndie]);

  const active = engine === 'indie' ? indie : benchmark;
  return { ...active, engine };
}
