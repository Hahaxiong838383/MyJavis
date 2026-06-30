/**
 * 火山 ASR v3（bigmodel）—— WebSocket 流式识别骨架。
 *
 * 抽取自 P003 providers/volc-asr.ts。火山用私有二进制帧协议（4 字节 header +
 * gzip payload），完整编解码需对照火山文档 + P003 源码移植，故此处是结构骨架，
 * 标 TODO 的部分接线真实 key 时补全。
 *
 * 协议要点（P003 已验证）：
 *  - 认证头：X-Api-App-Key / X-Api-Access-Token / X-Api-Resource-Id / X-Api-Connect-Id
 *  - 首帧发 JSON 配置（full client request），后续发 audio-only 帧
 *  - 返回帧解析 flags & 0x0f 判断 partial / definite
 *  - VAD 判停：vad_segment_duration（成人可调 600-800ms）
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { AsrProvider, AsrCallbacks } from './types.js';

export interface VolcAsrOptions {
  /** 句尾判停窗（ms）。P003 儿童 1200；成人建议 600-800 抢响应 */
  vadSegmentDuration?: number;
  endWindowSize?: number;
  sampleRate?: number;
}

export class VolcAsr implements AsrProvider {
  private ws?: WebSocket;
  private cb: AsrCallbacks = {};

  constructor(private readonly opts: VolcAsrOptions = {}) {}

  async start(cb: AsrCallbacks): Promise<void> {
    this.cb = cb;
    this.ws = new WebSocket(config.asr.endpoint, {
      headers: {
        'X-Api-App-Key': config.asr.appId,
        'X-Api-Access-Token': config.asr.accessToken,
        'X-Api-Resource-Id': config.asr.resourceId,
        'X-Api-Connect-Id': randomUUID(),
      },
    });

    await new Promise<void>((resolve, reject) => {
      this.ws!.on('open', () => {
        this.sendConfig();
        resolve();
      });
      this.ws!.on('error', (e) => {
        this.cb.onError?.(e as Error);
        reject(e);
      });
      this.ws!.on('message', (data) => this.handleFrame(data as Buffer));
    });
  }

  /** 首帧 full client request（JSON 配置）。TODO: 按火山二进制帧格式封包 */
  private sendConfig(): void {
    const _configPayload = {
      user: { uid: 'myjavis-user' },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: this.opts.sampleRate ?? 16000,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true,
        vad_segment_duration: this.opts.vadSegmentDuration ?? 800,
        end_window_size: this.opts.endWindowSize ?? 1000,
        force_to_speech_time: 0,
      },
    };
    // TODO: encodeFullClientRequest(_configPayload) → ws.send(binaryFrame)
  }

  /** 喂 PCM。TODO: 封装 audio-only 二进制帧（含序号/last 标记） */
  feed(_pcm: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // TODO: this.ws.send(encodeAudioOnlyFrame(_pcm))
  }

  end(): void {
    // TODO: 发送 last=true 的空 audio 帧通知 EOF
  }

  /** 解析返回帧。TODO: 按 flags & 0x0f 判断 partial/definite，提取 text */
  private handleFrame(_data: Buffer): void {
    // const { isPartial, isDefinite, text } = decodeServerFrame(_data);
    // if (isDefinite) this.cb.onFinal?.(text); else this.cb.onPartial?.(text);
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
  }
}
