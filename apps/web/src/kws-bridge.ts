/**
 * 贾维斯唤醒词（Rust 侧 KWS 引擎）的前端桥。
 *
 * 采音两模式（2026-07-06 数字混合实验后重构，实验结论见 src-tauri/src/kws.rs 头注）：
 *  - fed（首选）：本文件用 getUserMedia({echoCancellation:true}) 在 WebView 侧采麦，
 *    AudioWorklet 攒包后 invoke kws_feed 喂 Rust。系统 AEC 把 App 自播的音乐从
 *    mic 信号里消掉——音乐外放下喊"贾维斯"能被听清的关键（智能音箱正解）。
 *  - cpal（降级）：WebView 采麦失败（权限/设备异常）时退回 Rust 直采（无 AEC，
 *    音乐外放下命中率低，安静环境可用）。
 *
 * - 仅在 Tauri 环境生效（桌面 App）；浏览器/preview 里全部优雅降级为 no-op
 *   （dev 网页照常跑，唤醒只能点球 PTT——KWS 是桌面壳的原生能力）。
 * - Tauri API 动态 import：避免 vite 在纯 web 构建时把依赖打进首屏。
 */

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** AudioWorklet 源码（blob 内联，免打包配置）：攒 2048 样本（16kHz 下 ~128ms）一包。 */
const WORKLET_SRC = `
class KwsTap extends AudioWorkletProcessor {
  constructor() { super(); this.bufs = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.bufs.push(new Float32Array(ch));
      this.len += ch.length;
      if (this.len >= 2048) {
        const all = new Float32Array(this.len);
        let o = 0;
        for (const b of this.bufs) { all.set(b, o); o += b.length; }
        this.port.postMessage(all, [all.buffer]);
        this.bufs = []; this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('kws-tap', KwsTap);
`;

interface FeedPipeline {
  ctx: AudioContext;
  stream: MediaStream;
  src: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
}

let feedPipeline: FeedPipeline | null = null;

async function startFedMode(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  try {
    // 16kHz 上下文：WebKit 自动把 mic 流重采样到 context rate，Rust 侧免二次重采
    const ctx = new AudioContext({ sampleRate: 16000 });
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('kws_start', { mode: 'fed', sampleRate: Math.round(ctx.sampleRate) });
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'kws-tap');
    node.port.onmessage = (e: MessageEvent) => {
      const samples = e.data as Float32Array;
      void invoke('kws_feed', { samples: Array.from(samples) }).catch(() => {});
    };
    src.connect(node); // 不接 destination：只采不放
    feedPipeline = { ctx, stream, src, node };
    console.log(`[kws] started (webview-aec fed mode, rate=${ctx.sampleRate})`);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
}

async function stopFedMode(): Promise<void> {
  const p = feedPipeline;
  feedPipeline = null;
  if (!p) return;
  try {
    p.node.port.onmessage = null;
    p.src.disconnect();
    p.node.disconnect();
    p.stream.getTracks().forEach((t) => t.stop());
    await p.ctx.close();
  } catch {
    /* 清理失败不阻塞 */
  }
}

export async function kwsStart(): Promise<void> {
  if (!isTauri()) return;
  try {
    await startFedMode();
    return;
  } catch (e) {
    console.log('[kws] webview mic failed, fallback to cpal:', (e as Error)?.message ?? e);
  }
  // 降级：Rust cpal 直采（无 AEC）
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('kws_start');
    console.log('[kws] start requested (cpal fallback)');
  } catch (e) {
    console.log('[kws] start failed:', (e as Error)?.message ?? e);
  }
}

export async function kwsStop(): Promise<void> {
  if (!isTauri()) return;
  await stopFedMode();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('kws_stop');
  } catch (e) {
    console.log('[kws] stop failed:', (e as Error)?.message ?? e);
  }
}

/** 订阅唤醒事件。返回取消函数（非 Tauri 环境返回 null）。 */
export async function onKwsWake(cb: (keyword: string) => void): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<{ keyword: string }>('kws-wake', (event) => {
      cb(event.payload?.keyword ?? '');
    });
    return unlisten;
  } catch (e) {
    console.log('[kws] listen failed:', (e as Error)?.message ?? e);
    return null;
  }
}

/** 订阅 KWS 运行时错误（如双进程采麦被拒/资源缺失）——用于 UI 提示回退点球唤醒。 */
export async function onKwsError(cb: (msg: string) => void): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<string>('kws-error', (event) => {
      cb(String(event.payload ?? 'unknown'));
    });
    return unlisten;
  } catch {
    return null;
  }
}

/** 是否 Tauri 桌面环境（决定 guard 标签显示"喊贾维斯"还是"点我唤醒"）。 */
export function kwsAvailable(): boolean {
  return isTauri();
}
