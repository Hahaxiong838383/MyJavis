/**
 * 声纹管理 REST（走 /api/* 的 X-Javis-Key 鉴权）：
 *   POST   /api/voiceprint/register  { displayName, wavBase64, metaInfo? } → 注册火山声纹 + 入本地 registry
 *   GET    /api/voiceprint/list      本地 registry；?remote=1 附带火山侧清单（对账用）
 *   DELETE /api/voiceprint/:id       火山删除 + 本地删除
 *
 * 音频要求（火山硬性，PDF 页 7791）：16kHz/16bit/单声道 WAV，总时长 15~30s，
 * 有效语音 ≥12s（前端录音时按能量估算保证；这里只能验头部）。
 */
import { Hono } from 'hono';
import { registerVoicePrint, listVoicePrint, deleteVoicePrint } from '../voiceprint/volc-api.js';
import { assertRegisterableWav } from '../voiceprint/wav.js';
import {
  MAX_ACTIVE_VOICEPRINTS,
  findByDisplayName,
  listActiveVoiceprints,
  newAudioName,
  removeVoiceprint,
  saveVoiceprint,
} from '../voiceprint/registry.js';

const voiceprintRoute = new Hono();

voiceprintRoute.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    displayName?: string;
    wavBase64?: string;
    metaInfo?: string;
  } | null;
  const displayName = body?.displayName?.trim();
  const wavBase64 = body?.wavBase64?.trim();
  if (!displayName || !wavBase64) {
    return c.json({ ok: false, error: 'displayName + wavBase64 必填' }, 400);
  }
  if (displayName.length > 16) {
    return c.json({ ok: false, error: '名字太长（≤16 字）' }, 400);
  }

  const existing = listActiveVoiceprints();
  const sameName = findByDisplayName(displayName);
  if (!sameName && existing.length >= MAX_ACTIVE_VOICEPRINTS) {
    return c.json(
      {
        ok: false,
        error: `声纹识别最多同时支持 ${MAX_ACTIVE_VOICEPRINTS} 人（火山限制），请先删除一个再注册`,
        existing: existing.map((r) => ({ voiceprintId: r.voiceprintId, displayName: r.displayName })),
      },
      409,
    );
  }

  let wavInfo;
  try {
    wavInfo = assertRegisterableWav(wavBase64);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400);
  }

  try {
    const audioName = sameName?.audioName ?? newAudioName();
    const voiceprintId = await registerVoicePrint({
      audioName,
      wavBase64,
      metaInfo: body?.metaInfo ?? `MyJavis ${displayName}`,
    });
    // 同名重注册 = 换声纹样本：新 ID 生效后删旧 ID（火山侧+本地），保持一人一纹
    if (sameName && sameName.voiceprintId !== voiceprintId) {
      await deleteVoicePrint(sameName.voiceprintId).catch((err) =>
        console.log(`[voiceprint] 旧声纹清理失败（不阻塞）：${(err as Error).message}`),
      );
      removeVoiceprint(sameName.voiceprintId);
    }
    const record = saveVoiceprint({ voiceprintId, audioName, displayName, metaInfo: body?.metaInfo });
    console.log(
      `[voiceprint] registered "${displayName}" id=${voiceprintId} owner=${record.ownerId} dur=${wavInfo.durationSec.toFixed(1)}s${sameName ? ' (重注册)' : ''}`,
    );
    return c.json({ ok: true, voiceprint: record, replaced: sameName?.voiceprintId });
  } catch (err) {
    console.log(`[voiceprint] register failed: ${(err as Error).message}`);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

voiceprintRoute.get('/list', async (c) => {
  const local = listActiveVoiceprints();
  if (c.req.query('remote') !== '1') return c.json({ ok: true, voiceprints: local });
  try {
    const remote = await listVoicePrint();
    return c.json({ ok: true, voiceprints: local, remote });
  } catch (err) {
    return c.json({ ok: true, voiceprints: local, remoteError: (err as Error).message });
  }
});

voiceprintRoute.delete('/:id', async (c) => {
  const voiceprintId = c.req.param('id')?.trim();
  if (!voiceprintId) return c.json({ ok: false, error: '声纹 ID 必填' }, 400);
  try {
    await deleteVoicePrint(voiceprintId);
  } catch (err) {
    // 火山侧已不存在时继续删本地（对账韧性）；其他错误如实报
    const msg = (err as Error).message;
    if (!/not.*(exist|found)|不存在/i.test(msg)) {
      return c.json({ ok: false, error: msg }, 502);
    }
    console.log(`[voiceprint] 火山侧已不存在，仅删本地：${voiceprintId}`);
  }
  const removed = removeVoiceprint(voiceprintId);
  console.log(`[voiceprint] deleted id=${voiceprintId} local=${removed}`);
  return c.json({ ok: true, removed });
});

export { voiceprintRoute };
