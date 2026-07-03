/**
 * 火山 RTC OpenAPI 通用调用（AK/SK 签名），供 rtc.ts（StartVoiceChat 等）与
 * voiceprint.ts（RegisterVoicePrint 四件套）共用。host/region/version 全站一致（2024-12-01）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// @volcengine/openapi 是 CJS，用 require 避免 ESM interop 问题。
const { Signer } = require('@volcengine/openapi') as {
  Signer: new (req: Record<string, unknown>, service: string) => {
    addAuthorization: (cred: { accessKeyId: string; secretKey: string }) => void;
  };
};

export const RTC_HOST = 'rtc.volcengineapi.com';
export const RTC_REGION = 'cn-north-1';
export const RTC_VERSION = '2024-12-01';

export interface VolcApiError {
  Code: string;
  Message: string;
}

/**
 * 用 AK/SK 签名调火山 RTC OpenAPI。
 * timeoutMs：声纹注册（音频上传+声纹生成）官方建议 15s+，默认 30s；普通接口用默认即可。
 */
export async function callRtcOpenAPI(
  action: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<any> {
  const reqData = {
    region: RTC_REGION,
    method: 'POST',
    params: { Action: action, Version: RTC_VERSION },
    headers: { Host: RTC_HOST, 'Content-Type': 'application/json' },
    body,
  };
  const signer = new Signer(reqData, 'rtc');
  signer.addAuthorization({
    accessKeyId: process.env.VOLC_ACCESS_KEY_ID || '',
    secretKey: process.env.VOLC_SECRET_ACCESS_KEY || '',
  });
  const res = await fetch(`https://${RTC_HOST}?Action=${action}&Version=${RTC_VERSION}`, {
    method: 'POST',
    headers: reqData.headers as Record<string, string>,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

/** 提取火山公共返回结构里的错误（无错时返回 undefined）。 */
export function volcApiError(result: any): VolcApiError | undefined {
  return result?.ResponseMetadata?.Error;
}
