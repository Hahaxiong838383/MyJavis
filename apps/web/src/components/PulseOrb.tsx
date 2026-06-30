import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { VoiceStatus } from '../store';

type PulseMode = 'idle' | 'mic' | 'think' | 'speak';
type AudioBuffers = { time: Float32Array<ArrayBuffer>; frequency: Uint8Array<ArrayBuffer> };

export interface PulseSignals {
  volume: number;
  pitch: number;
  rhythm: number;
}

export interface PulseOrbHandle {
  pushSignals: (signals: Partial<PulseSignals>) => void;
}

export interface PulseOrbProps {
  phase: VoiceStatus;
  label?: string;
}

const PulseOrb = forwardRef<PulseOrbHandle, PulseOrbProps>(function PulseOrb({ phase, label }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const signalsRef = useRef<PulseSignals>({ volume: 0, pitch: 0.42, rhythm: 0 });
  const modeRef = useRef<PulseMode>('idle');
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<AudioBuffers | null>(null);

  const mode = useMemo(() => phaseToMode(phase), [phase]);

  useImperativeHandle(ref, () => ({
    pushSignals(signals) {
      const current = signalsRef.current;
      signalsRef.current = {
        volume: clamp01(signals.volume ?? current.volume),
        pitch: clamp01(signals.pitch ?? current.pitch),
        rhythm: clamp01(signals.rhythm ?? current.rhythm),
      };
    },
  }));

  useEffect(() => {
    modeRef.current = mode;
    if (mode !== 'mic') stopMic(streamRef, analyserRef, buffersRef);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    if (mode !== 'mic') return;
    void startMic({ audioContextRef, analyserRef, streamRef, buffersRef }).then((ok) => {
      if (cancelled && ok) stopMic(streamRef, analyserRef, buffersRef);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let previousVolume = 0;
    let lastOnset = 0;
    const ripples: Array<{ radius: number; alpha: number }> = [];

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const frame = (timeMs: number) => {
      const time = timeMs / 1000;
      const modeNow = modeRef.current;
      const target = readTargetSignals(modeNow, time, signalsRef, analyserRef, buffersRef);
      const current = signalsRef.current;
      current.volume += (target.volume - current.volume) * (target.volume > current.volume ? 0.38 : 0.12);
      current.pitch += (target.pitch - current.pitch) * 0.08;
      current.rhythm *= 0.92;

      const rising = current.volume - previousVolume;
      if (current.volume > 0.18 && rising > 0.055 && time - lastOnset > 0.14) {
        lastOnset = time;
        current.rhythm = 1;
        ripples.push({ radius: baseRadius(width, height) * (1 + current.volume * 0.3), alpha: 0.52 });
      }
      previousVolume = current.volume;

      draw(ctx, width, height, time, modeNow, current, ripples);
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      stopMic(streamRef, analyserRef, buffersRef);
      void audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  return (
    <div style={styles.shell} aria-label={`Javis Pulse ${phase}`}>
      <canvas ref={canvasRef} style={styles.canvas} />
      <div style={styles.brand}>Javis Pulse</div>
      <div style={styles.badge}>{label ?? phaseLabel(phase)}</div>
    </div>
  );
});

export { PulseOrb };

function phaseToMode(phase: VoiceStatus): PulseMode {
  if (phase === 'listening') return 'mic';
  if (phase === 'thinking') return 'think';
  if (phase === 'speaking') return 'speak';
  return 'idle';
}

function phaseLabel(phase: VoiceStatus): string {
  if (phase === 'listening') return '麦克风输入';
  if (phase === 'thinking') return '低幅思考';
  if (phase === 'speaking') return 'Javis 输出';
  return '静息';
}

async function startMic(args: {
  audioContextRef: React.MutableRefObject<AudioContext | null>;
  analyserRef: React.MutableRefObject<AnalyserNode | null>;
  streamRef: React.MutableRefObject<MediaStream | null>;
  buffersRef: React.MutableRefObject<AudioBuffers | null>;
}): Promise<boolean> {
  if (args.analyserRef.current) return true;
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const audioContext = args.audioContextRef.current ?? new AudioContextCtor();
    args.audioContextRef.current = audioContext;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    args.streamRef.current = stream;
    args.analyserRef.current = analyser;
    args.buffersRef.current = {
      time: new Float32Array(new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT * analyser.fftSize)),
      frequency: new Uint8Array(new ArrayBuffer(Uint8Array.BYTES_PER_ELEMENT * analyser.frequencyBinCount)),
    };
    return true;
  } catch {
    return false;
  }
}

function stopMic(
  streamRef: React.MutableRefObject<MediaStream | null>,
  analyserRef: React.MutableRefObject<AnalyserNode | null>,
  buffersRef: React.MutableRefObject<AudioBuffers | null>,
): void {
  streamRef.current?.getTracks().forEach((track) => track.stop());
  streamRef.current = null;
  analyserRef.current = null;
  buffersRef.current = null;
}

function readTargetSignals(
  mode: PulseMode,
  time: number,
  signalsRef: React.MutableRefObject<PulseSignals>,
  analyserRef: React.MutableRefObject<AnalyserNode | null>,
  buffersRef: React.MutableRefObject<AudioBuffers | null>,
): PulseSignals {
  // TODO: 火山 enableAudioPropertiesReport 真接后，由外部通过 pushSignals 注入音量/音调/律动。
  if (mode === 'speak') return synthSpeech(time, 1);
  if (mode === 'think') return synthSpeech(time * 0.7, 0.28);
  if (mode === 'mic') {
    const fromMic = readMic(analyserRef.current, buffersRef.current, signalsRef.current.pitch);
    if (fromMic.volume > 0) return fromMic;
    return { volume: 0.08 + Math.max(0, Math.sin(time * 2.1)) * 0.08, pitch: 0.45, rhythm: 0 };
  }
  return { volume: 0.02 + Math.max(0, Math.sin(time * 0.9)) * 0.035, pitch: 0.42, rhythm: 0 };
}

function synthSpeech(time: number, scale: number): PulseSignals {
  const burst = Math.max(0, Math.sin(time * 7)) * Math.max(0, Math.sin(time * 2.1 + 0.6));
  const fine = 0.6 + 0.4 * Math.sin(time * 13 + Math.sin(time * 3));
  const gap = Math.sin(time * 0.7) > -0.55 ? 1 : 0;
  const volume = Math.min(1, burst * fine * gap * 1.15 * scale);
  const pitch = clamp01(0.5 + 0.4 * Math.sin(time * 1.3) + 0.1 * Math.sin(time * 5.7));
  return { volume, pitch, rhythm: 0 };
}

function readMic(
  analyser: AnalyserNode | null,
  buffers: AudioBuffers | null,
  fallbackPitch: number,
): PulseSignals {
  if (!analyser || !buffers) return { volume: 0, pitch: fallbackPitch, rhythm: 0 };
  analyser.getFloatTimeDomainData(buffers.time);
  let rms = 0;
  for (const sample of buffers.time) rms += sample * sample;
  const volume = Math.min(1, Math.sqrt(rms / buffers.time.length) * 3.4);

  analyser.getByteFrequencyData(buffers.frequency);
  let numerator = 0;
  let denominator = 0;
  buffers.frequency.forEach((value, index) => {
    numerator += index * value;
    denominator += value;
  });
  const pitch = denominator > 0 ? clamp01((numerator / denominator / buffers.frequency.length) * 2.2) : fallbackPitch;
  return { volume, pitch, rhythm: 0 };
}

function draw(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  mode: PulseMode,
  signals: PulseSignals,
  ripples: Array<{ radius: number; alpha: number }>,
): void {
  const cx = width / 2;
  const cy = height / 2;
  const radius = baseRadius(width, height) * (1 + signals.volume * 0.55);
  const thinking = mode === 'think';
  const hue = thinking ? 45 : 200 - signals.pitch * 55;
  const energy = thinking ? Math.max(signals.volume, 0.18) : signals.volume;
  const lobes = thinking ? 4 : 3 + Math.round(signals.pitch * 8);
  const amplitude = thinking ? 12 + energy * 24 : 6 + energy * 70;

  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(4,6,12,0.28)';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 3.2);
  glow.addColorStop(0, `hsla(${hue},90%,60%,${0.05 + energy * 0.12})`);
  glow.addColorStop(1, 'hsla(200,90%,60%,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  drawWave(ctx, cx, cy, width, amplitude, lobes, time, hue, energy, thinking);

  for (let index = ripples.length - 1; index >= 0; index -= 1) {
    const ripple = ripples[index]!;
    ripple.radius += 4.5 + energy * 4;
    ripple.alpha *= 0.945;
    if (ripple.alpha < 0.02) {
      ripples.splice(index, 1);
      continue;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, ripple.radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsla(${hue},90%,70%,${ripple.alpha})`;
    ctx.stroke();
  }

  drawBlob(ctx, cx, cy, radius * 0.78, amplitude * 0.6, lobes, time * 0.9, hue, energy, 0.35, thinking);
  drawBlob(ctx, cx, cy, radius, amplitude, lobes, time, hue, energy, 0.9, thinking);

  const flash = Math.min(1, energy * 0.7 + signals.rhythm * 0.6);
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.7);
  core.addColorStop(0, `hsla(${hue},${90 - flash * 70}%,${60 + flash * 38}%,${0.45 + flash * 0.4})`);
  core.addColorStop(1, `hsla(${hue},90%,60%,0)`);
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.7, 0, Math.PI * 2);
  ctx.fill();
}

function drawBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  amplitude: number,
  lobes: number,
  time: number,
  hue: number,
  energy: number,
  alpha: number,
  thinking: boolean,
): void {
  const steps = 200;
  ctx.beginPath();
  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    const wobble =
      Math.sin(angle * lobes + time * 1.5) +
      Math.sin(angle * lobes * 2 - time * 1.1) * 0.4 +
      Math.sin(angle * (thinking ? 7 : 3) + time * 0.7) * 0.3;
    const r = radius + wobble * amplitude;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const light = 46 + energy * 40;
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius + amplitude);
  gradient.addColorStop(0, `hsla(${hue},${90 - energy * 40}%,${Math.min(92, light + 28)}%,${0.85 * alpha})`);
  gradient.addColorStop(0.6, `hsla(${hue},88%,${light}%,${0.4 * alpha})`);
  gradient.addColorStop(1, `hsla(${hue},85%,${light - 8}%,0)`);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = thinking ? 1.1 : 1.4;
  ctx.strokeStyle = `hsla(${hue},95%,${Math.min(95, light + 30)}%,${0.55 * alpha})`;
  ctx.stroke();
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  amplitude: number,
  lobes: number,
  time: number,
  hue: number,
  energy: number,
  thinking: boolean,
): void {
  ctx.beginPath();
  const span = Math.min(width, 1100);
  const x0 = cx - span / 2;
  const steps = 160;
  for (let step = 0; step <= steps; step += 1) {
    const fraction = step / steps;
    const x = x0 + fraction * span;
    const envelope = Math.sin(fraction * Math.PI) ** 1.4;
    const wave =
      Math.sin(fraction * Math.PI * 2 * lobes + time * (thinking ? 1.8 : 4)) * 0.6 +
      Math.sin(fraction * Math.PI * 2 * lobes * 0.5 - time * 2.3) * 0.4;
    const y = cy + wave * amplitude * 0.9 * envelope;
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 1.6 + energy * 1.6;
  ctx.strokeStyle = `hsla(${hue},95%,${60 + energy * 25}%,${0.22 + energy * 0.35})`;
  ctx.stroke();
}

function baseRadius(width: number, height: number): number {
  return Math.max(58, Math.min(width, height) * 0.24);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: 'relative',
    width: 'min(78vw, 360px)',
    aspectRatio: '1 / 1',
    borderRadius: '32px',
    overflow: 'hidden',
    background: '#04060c',
    boxShadow: '0 28px 80px rgba(0,0,0,.35), inset 0 0 0 1px rgba(70,207,224,.12)',
  },
  canvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  brand: {
    position: 'absolute',
    top: 18,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 11,
    letterSpacing: '.42em',
    textTransform: 'uppercase',
    color: 'rgba(207,233,238,.34)',
    fontFamily: 'ui-monospace, Menlo, monospace',
  },
  badge: {
    position: 'absolute',
    left: '50%',
    bottom: 18,
    transform: 'translateX(-50%)',
    padding: '7px 12px',
    borderRadius: 999,
    border: '1px solid rgba(70,207,224,.22)',
    background: 'rgba(4,6,12,.42)',
    color: 'rgba(207,233,238,.72)',
    fontSize: 12,
    backdropFilter: 'blur(10px)',
  },
};
