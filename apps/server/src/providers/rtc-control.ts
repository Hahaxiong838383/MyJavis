/**
 * 对话中的实时控制指令（UpdateVoiceChat，2024-12-01 版 Command 枚举见 PDF 页 7745）。
 * 与 volc-inject.mjs（生产验证过的调试脚本）同参数形态。
 */
import { callRtcOpenAPI, volcApiError } from './volc-openapi.js';

/** 让 Javis 直接播报一段固定文本（ExternalTextToSpeech：进 TTS 不走 LLM，绝对可控）。 */
export async function speakText(roomId: string, text: string, interrupt = false): Promise<void> {
  const result = await callRtcOpenAPI('UpdateVoiceChat', {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: roomId, // 本项目一房一任务（TaskId=roomId，见 rtc.ts）
    Command: 'ExternalTextToSpeech',
    Message: text,
    InterruptMode: interrupt ? 1 : 2, // 1=打断当前播报立即说；2=排队等说完再说
  });
  const err = volcApiError(result);
  if (err) throw new Error(`ExternalTextToSpeech 失败：${err.Code}: ${err.Message}`);
}

/** 注入文本模拟用户提问（ExternalTextToLLM：走 CustomLLM 回调，触发 LLM 回复）。 */
export async function injectTextToLlm(roomId: string, text: string): Promise<void> {
  const result = await callRtcOpenAPI('UpdateVoiceChat', {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: roomId,
    Command: 'ExternalTextToLLM',
    Message: text,
    InterruptMode: 1,
  });
  const err = volcApiError(result);
  if (err) throw new Error(`ExternalTextToLLM 失败：${err.Code}: ${err.Message}`);
}
