/**
 * 火山声纹识别标签解析（批次3）。
 *
 * 开启 VoicePrint Mode=2 后，火山把说话人标签拼进发给 LLM 的消息文本
 * （官方 prompt 示例形态：`(当前说话人是{AudioName})`，PDF 页 7485-7486）。
 * 标签确切位置/括号全半角文档未明示 → 解析器宽容匹配（全/半角括号、任意位置、可多个），
 * 真实形态以生产日志为准（custom-llm 有 rawHead 观测日志）。
 *
 * 标签是 server 的身份信号，**不透传给 LLM、不进记忆**——LLM 看到的是 cleanText +
 * prompt 末尾的结构化身份段（防标签文本被复读/写进记忆）。
 */
import { findByAudioName, type VoiceprintRecord } from './registry.js';
import type { VolcSpeakerPayload } from '../memory/types.js';

const TAG_RE = /[（(]\s*当前说话人是\s*[:：]?\s*([^（）()]{1,64}?)\s*[）)]/g;

export interface SpeakerTagResult {
  cleanText: string;
  /** 标签里的 AudioName（注册时我们生成的 jv_xxx slug）；无标签为 undefined。 */
  audioName?: string;
}

/** 剥出说话人标签：返回去标签后的干净文本 + 首个标签的 AudioName。 */
export function parseSpeakerTag(text: string): SpeakerTagResult {
  let audioName: string | undefined;
  const cleanText = text
    .replace(TAG_RE, (_m, name: string) => {
      audioName ??= name.trim();
      return '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { cleanText, audioName };
}

/** 只清洗不取名（history 消息用）。 */
export function stripSpeakerTag(text: string): string {
  return parseSpeakerTag(text).cleanText;
}

export interface ResolvedSpeaker {
  payload: VolcSpeakerPayload;
  record?: VoiceprintRecord;
}

/**
 * AudioName → registry 反查 → 真实 VolcSpeakerPayload。
 * status='active' 语义：火山打出标签 = 实时声纹已过 StartVoiceChat 的 Score 阈值
 * （火山不回传实时相似度分，所以 payload 不带 score，由 identity 状态机按 active 定级）。
 * registry 查不到（server 换库/火山残留旧声纹）→ 按无声纹处理（unverified，记忆进 quarantine）。
 */
export function resolveSpeakerFromTag(audioName: string, roomId: string | undefined): ResolvedSpeaker {
  const record = findByAudioName(audioName);
  if (!record) {
    return {
      payload: { provider: 'volc', roomId, mode: '2', raw: { audioName, unmatchedTag: true } },
    };
  }
  return {
    record,
    payload: {
      provider: 'volc',
      roomId,
      voiceprintId: record.voiceprintId,
      voiceprintName: record.displayName,
      mode: '2',
      status: 'active',
      raw: { audioName, source: 'volc_speaker_tag' },
    },
  };
}
