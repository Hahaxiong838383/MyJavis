/**
 * 火山 TTS（Doubao 双向流）—— WebSocket 流式合成骨架。
 *
 * 抽取自 P003 providers/volc-tts.ts。同样是私有二进制帧协议，此处结构骨架 + 协议要点。
 *
 * ⚠️ P003 血泪坑（务必带入 MyJavis）：
 *  - event 350 TTSSentenceStart → 句开始，带权威句文本，用于字幕对齐（onCue）
 *  - event 351 SentenceEnd 是【句末标点·中段】，每个逗号句号都发，**不是流结束**！
 *    P003 曾误当流结束 → 第一个标点就锁死后续音频。
 *  - event 152 SessionFinished 才是真正流结束（onEnd）
 *  - 认证头是小写 x-api-key（不是 X-Api-*）
 *  - 音色 zh_female_tianmeixiaoyuan_moon_bigtts（MyJavis 可换成人音色）
 */

import { WebSocket } from 'ws';
import { config } from '../config.js';
import type { TtsProvider, TtsCallbacks } from './types.js';

const EVENT_TTS_SENTENCE_START = 350;
const EVENT_TTS_SENTENCE_END_MID = 351; // 中段标点，不是结束
const EVENT_SESSION_FINISHED = 152; // 真正结束

export class VolcTts implements TtsProvider {
  private ws?: WebSocket;
  private cb: TtsCallbacks = {};
  private sentenceIndex = 0;

  async start(cb: TtsCallbacks): Promise<void> {
    this.cb = cb;
    this.sentenceIndex = 0;
    this.ws = new WebSocket(config.tts.endpoint, {
      headers: { 'x-api-key': config.tts.accessToken }, // 注意小写
    });

    await new Promise<void>((resolve, reject) => {
      this.ws!.on('open', () => {
        // TODO: 发送 StartSession 帧（含 voice / appId）
        resolve();
      });
      this.ws!.on('error', (e) => {
        this.cb.onError?.(e as Error);
        reject(e);
      });
      this.ws!.on('message', (data) => this.handleFrame(data as Buffer));
    });
  }

  /** 喂待合成文本（可分句流式喂）。TODO: 封 TaskRequest 帧 */
  feed(_text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // TODO: this.ws.send(encodeTtsTextFrame(_text))
  }

  finish(): void {
    // TODO: 发送 FinishSession 帧
  }

  /** 解析返回帧。TODO: 解出 event 号 + payload */
  private handleFrame(_data: Buffer): void {
    // const { event, payload, audioChunk } = decodeTtsFrame(_data);
    // switch (event) {
    //   case EVENT_TTS_SENTENCE_START:
    //     this.cb.onCue?.(this.sentenceIndex, payload.text);
    //     break;
    //   case EVENT_TTS_SENTENCE_END_MID:
    //     this.cb.onSentenceBreak?.(this.sentenceIndex);
    //     this.sentenceIndex++;
    //     break;
    //   case EVENT_SESSION_FINISHED:
    //     this.cb.onEnd?.();
    //     break;
    //   default: // mp3 audio chunk
    //     if (audioChunk) this.cb.onAudio?.(audioChunk, this.sentenceIndex);
    // }
    void EVENT_TTS_SENTENCE_START;
    void EVENT_TTS_SENTENCE_END_MID;
    void EVENT_SESSION_FINISHED;
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
  }
}
