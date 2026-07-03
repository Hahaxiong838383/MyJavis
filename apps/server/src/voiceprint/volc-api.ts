/**
 * 火山声纹管理四接口封装（PDF 页 7790-7798，全部 Version=2024-12-01）。
 *
 * RegisterVoicePrint 音频硬性要求（页 7791）：base64 WAV、16kHz/16bit/单声道、
 * 总时长 15~30s 且有效语音（非静音）≥12s、base64 后 ≤2MB。
 * 注册/更新含音频上传+声纹生成，官方建议 HTTP 超时 15s+（这里给 30s）。
 */
import { callRtcOpenAPI, volcApiError } from '../providers/volc-openapi.js';

export interface VolcVoicePrintItem {
  VoicePrintId: string;
  AudioName: string;
  MetaInfo?: string;
  CreatedAt: number; // Unix 秒
  UpdatedAt: number;
}

function appId(): string {
  const id = process.env.VOLC_RTC_APP_ID;
  if (!id) throw new Error('VOLC_RTC_APP_ID 未配置');
  return id;
}

function throwIfError(result: any, action: string): void {
  const err = volcApiError(result);
  if (err) throw new Error(`${action} 失败：${err.Code}: ${err.Message}`);
}

/** 注册声纹，返回火山声纹 ID。 */
export async function registerVoicePrint(args: {
  audioName: string;
  wavBase64: string;
  metaInfo?: string;
}): Promise<string> {
  const result = await callRtcOpenAPI(
    'RegisterVoicePrint',
    {
      AppId: appId(),
      AudioName: args.audioName,
      AudioFormat: 0, // 固定 0 = WAV
      Audio: args.wavBase64,
      AudioMetaInfo: args.metaInfo ?? '',
    },
    30_000,
  );
  throwIfError(result, 'RegisterVoicePrint');
  const id = result?.Result;
  if (typeof id !== 'string' || !id) throw new Error('RegisterVoicePrint 成功但未返回声纹 ID');
  return id;
}

/** 查询声纹（不传 idList = 全量默认分页；量级个位数，够用）。 */
export async function listVoicePrint(idList?: string[]): Promise<VolcVoicePrintItem[]> {
  const body: Record<string, unknown> = { AppId: appId() };
  if (idList?.length) body.VoicePrintIdList = idList.slice(0, 10);
  const result = await callRtcOpenAPI('ListVoicePrint', body);
  throwIfError(result, 'ListVoicePrint');
  return (result?.Result?.Items ?? []) as VolcVoicePrintItem[];
}

/** 更新声纹（换音频 / 改名 / 改备注）。 */
export async function updateVoicePrint(args: {
  voicePrintId: string;
  wavBase64?: string;
  audioName?: string;
  metaInfo?: string;
}): Promise<void> {
  const body: Record<string, unknown> = { AppId: appId(), VoicePrintId: args.voicePrintId };
  if (args.wavBase64) body.Audio = args.wavBase64;
  if (args.audioName) body.AudioName = args.audioName;
  if (args.metaInfo !== undefined) body.AudioMetaInfo = args.metaInfo;
  const result = await callRtcOpenAPI('UpdateVoicePrint', body, 30_000);
  throwIfError(result, 'UpdateVoicePrint');
}

/** 删除声纹（火山侧不可逆）。 */
export async function deleteVoicePrint(voicePrintId: string): Promise<void> {
  const result = await callRtcOpenAPI('DeleteVoicePrint', { AppId: appId(), VoicePrintId: voicePrintId });
  throwIfError(result, 'DeleteVoicePrint');
}
