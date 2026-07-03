/**
 * WAV 头解析与注册前校验（系统边界输入验证，fail fast）。
 *
 * 火山 RegisterVoicePrint 要求（PDF 页 7791）：16kHz / 16bit / 单声道 PCM，
 * 总时长 15~30s，base64 后 ≤2MB。前端录错采样率在这里就报清楚，不等火山模糊报错。
 * 「有效语音 ≥12s」是内容层要求，头部验不了——由前端录音时的能量估算保证，火山侧兜底。
 */

export interface WavInfo {
  audioFormat: number; // 1 = PCM
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSec: number;
}

/** 按 chunk 遍历解析 WAV 头（不假设 fmt/data 偏移固定，兼容带 LIST 等附加 chunk 的文件）。 */
export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < 44) throw new Error('WAV 文件过短（不足 44 字节头）');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是合法 WAV（缺 RIFF/WAVE 标识）');
  }

  let fmt: Omit<WavInfo, 'dataBytes' | 'durationSec'> | null = null;
  let dataBytes = -1;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 8 + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      };
    } else if (chunkId === 'data') {
      // 有些编码器把 data size 写 0/溢出，用实际剩余字节兜底
      dataBytes = chunkSize > 0 && offset + 8 + chunkSize <= buf.length ? chunkSize : buf.length - offset - 8;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunk 按 2 字节对齐
  }

  if (!fmt) throw new Error('WAV 缺 fmt chunk');
  if (dataBytes < 0) throw new Error('WAV 缺 data chunk');
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return { ...fmt, dataBytes, durationSec: bytesPerSec > 0 ? dataBytes / bytesPerSec : 0 };
}

/** 校验是否满足火山注册要求，不满足抛带修复指引的错误。 */
export function assertRegisterableWav(wavBase64: string): WavInfo {
  if (wavBase64.length > 2 * 1024 * 1024) {
    throw new Error(`音频过大（base64 ${(wavBase64.length / 1024 / 1024).toFixed(2)}MB > 2MB 上限）`);
  }
  const buf = Buffer.from(wavBase64, 'base64');
  const info = parseWavHeader(buf);
  const problems: string[] = [];
  if (info.audioFormat !== 1) problems.push(`需 PCM 编码（当前 audioFormat=${info.audioFormat}）`);
  if (info.channels !== 1) problems.push(`需单声道（当前 ${info.channels} 声道）`);
  if (info.sampleRate !== 16000) problems.push(`需 16kHz 采样率（当前 ${info.sampleRate}Hz）`);
  if (info.bitsPerSample !== 16) problems.push(`需 16bit 位深（当前 ${info.bitsPerSample}bit）`);
  if (info.durationSec < 15 || info.durationSec > 30) {
    problems.push(`总时长需 15~30s（当前 ${info.durationSec.toFixed(1)}s）`);
  }
  if (problems.length) throw new Error(`音频不满足声纹注册要求：${problems.join('；')}`);
  return info;
}
