/**
 * 声纹旁路录音器：从 RTC 麦克风轨（已过 SDK 3A 处理）旁路采 PCM，产出火山注册要求的
 * 16kHz/16bit/单声道 WAV（总时长 15~30s、有效语音 ≥12s，见 server voiceprint/wav.ts）。
 *
 * 策略：
 * - AudioContext({sampleRate:16000}) 让浏览器实时重采样；不支持时（ctx 实际率≠16k）
 *   收原始率，停止时用 OfflineAudioContext 兜底重采样。
 * - 跳过头部静音（首个有效块之前丢弃）；RMS>阈值 的块计入"有效语音"秒数。
 * - 停止条件：有效 ≥14s 且总长 ≥15s（留火山 12s 要求的余量）；或总长 28s 强停。
 * - ScriptProcessor 经 gain=0 静音出口接 destination（部分浏览器不接不跑），绝不回放。
 */

export interface RecorderProgress {
  totalSec: number;
  effectiveSec: number;
  targetEffectiveSec: number;
}

export interface RecorderResult {
  wavBase64: string;
  totalSec: number;
  effectiveSec: number;
}

const TARGET_EFFECTIVE_SEC = 14;
const MIN_TOTAL_SEC = 15;
const MAX_TOTAL_SEC = 28;
const RMS_SPEECH_THRESHOLD = 0.02;

export class VoiceprintRecorder {
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private effectiveSamples = 0;
  private speechStarted = false;
  private finished = false;

  constructor(
    private readonly onProgress: (p: RecorderProgress) => void,
    private readonly onDone: (r: RecorderResult) => void,
    private readonly onError: (err: Error) => void,
  ) {}

  /** 开始旁路录音（不影响 RTC 发布流；track 必须是 live 的音频轨）。 */
  start(track: MediaStreamTrack): void {
    try {
      // 优先让浏览器直接以 16k 运行（实时重采样）；不支持的实现会忽略该选项
      this.ctx = new AudioContext({ sampleRate: 16000 });
      this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      this.processor.onaudioprocess = (e) => this.handleChunk(e.inputBuffer.getChannelData(0));
      this.source.connect(this.processor);
      this.processor.connect(silent);
      silent.connect(this.ctx.destination);
      void this.ctx.resume();
    } catch (err) {
      this.onError(err as Error);
    }
  }

  /** 主动停止并丢弃（用户挂断/会话过期）。 */
  cancel(): void {
    this.finished = true;
    this.teardown();
  }

  private handleChunk(data: Float32Array): void {
    if (this.finished || !this.ctx) return;
    const rms = chunkRms(data);
    const isSpeech = rms >= RMS_SPEECH_THRESHOLD;
    if (!this.speechStarted) {
      if (!isSpeech) return; // 头部静音丢弃（引导语播报期间用户还没开口）
      this.speechStarted = true;
    }
    this.chunks.push(new Float32Array(data)); // inputBuffer 复用底层内存，必须拷贝
    this.totalSamples += data.length;
    if (isSpeech) this.effectiveSamples += data.length;

    const rate = this.ctx.sampleRate;
    const totalSec = this.totalSamples / rate;
    const effectiveSec = this.effectiveSamples / rate;
    this.onProgress({ totalSec, effectiveSec, targetEffectiveSec: TARGET_EFFECTIVE_SEC });

    if ((effectiveSec >= TARGET_EFFECTIVE_SEC && totalSec >= MIN_TOTAL_SEC) || totalSec >= MAX_TOTAL_SEC) {
      this.finished = true;
      void this.finalize(totalSec, effectiveSec, rate);
    }
  }

  private async finalize(totalSec: number, effectiveSec: number, srcRate: number): Promise<void> {
    try {
      const merged = mergeChunks(this.chunks, this.totalSamples);
      const pcm16k = srcRate === 16000 ? merged : await resampleTo16k(merged, srcRate);
      this.onDone({ wavBase64: encodeWav16kBase64(pcm16k), totalSec, effectiveSec });
    } catch (err) {
      this.onError(err as Error);
    } finally {
      this.teardown();
    }
  }

  private teardown(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    void this.ctx?.close().catch(() => {});
    this.processor = null;
    this.source = null;
    this.ctx = null;
    this.chunks = [];
  }
}

function chunkRms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / data.length);
}

function mergeChunks(chunks: Float32Array[], totalSamples: number): Float32Array {
  const out = new Float32Array(totalSamples);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 浏览器忽略 sampleRate 选项时的兜底重采样（OfflineAudioContext 标准内核，质量优于线性插值）。 */
async function resampleTo16k(pcm: Float32Array, srcRate: number): Promise<Float32Array> {
  const targetLength = Math.ceil((pcm.length * 16000) / srcRate);
  const offline = new OfflineAudioContext(1, targetLength, 16000);
  const buf = offline.createBuffer(1, pcm.length, srcRate);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Float32 PCM（16kHz）→ 16bit WAV → base64（分块转码防 String.fromCharCode 栈溢出）。 */
function encodeWav16kBase64(pcm: Float32Array): string {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16000, true);
  view.setUint32(28, 16000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
