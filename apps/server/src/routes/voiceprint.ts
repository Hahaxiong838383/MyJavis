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
import { registerVoicePrint, listVoicePrint, deleteVoicePrint, updateVoicePrint } from '../voiceprint/volc-api.js';
import { assertRegisterableWav } from '../voiceprint/wav.js';
import {
  MAX_ACTIVE_VOICEPRINTS,
  findByDisplayName,
  getVoiceprint,
  listActiveVoiceprints,
  newAudioName,
  removeVoiceprint,
  renameVoiceprint,
  saveVoiceprint,
} from '../voiceprint/registry.js';
import {
  completeEnroll,
  enrollFailLine,
  enrollRetryLine,
  enrollSuccessLine,
  failEnroll,
  getEnroll,
} from '../voiceprint/enroll-session.js';
import { speakText } from '../providers/rtc-control.js';
import { effectiveTenant, type AppEnv } from '../tenant/context.js';
import type { Tenant } from '../tenant/registry.js';
import type { Context } from 'hono';

const voiceprintRoute = new Hono<AppEnv>();

/** 全部声纹端点都要求租户上下文（admin 走 ?tenantId= 或 DEFAULT_ADMIN_TENANT）。 */
function requireTenant(c: Context<AppEnv>): Tenant | Response {
  const tenant = effectiveTenant(c);
  return tenant ?? c.json({ ok: false, error: '无租户上下文（admin 需 ?tenantId= 或配 DEFAULT_ADMIN_TENANT）' }, 400);
}

/** 对话式注册：前端通话中轮询本端点，发现 recording 即开旁路录音。 */
voiceprintRoute.get('/pending', (c) => {
  const roomId = c.req.query('room')?.trim();
  if (!roomId) return c.json({ ok: false, error: 'room 必填' }, 400);
  const session = getEnroll(roomId);
  return c.json({
    ok: true,
    pending: session
      ? { displayName: session.displayName, state: session.state, attempt: session.attempt }
      : null,
  });
});

/**
 * 前端质量门触发重录：录到 28s 强停但有效语音不足（弱样本传给火山会成"合法但认不出"的
 * 声纹——川哥 28.2s 强停样本 0 次匹配的教训）。走与火山拒同一条 failEnroll 重试链。
 */
voiceprintRoute.post('/enroll-retry', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { roomId?: string; reason?: string } | null;
  const roomId = body?.roomId?.trim();
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  const session = getEnroll(roomId);
  if (!session || session.state !== 'recording') return c.json({ ok: true, pending: session ?? null });
  const retryable = failEnroll(roomId, body?.reason ?? 'insufficient_effective_speech');
  console.log(`[voiceprint] enroll-retry room=${roomId} reason=${body?.reason ?? '-'} retryable=${retryable}`);
  speakText(roomId, retryable ? enrollRetryLine() : enrollFailLine(), false).catch((err) =>
    console.log(`[voiceprint] 重录播报失败（不阻塞）：${(err as Error).message}`),
  );
  return c.json({ ok: true, retryable });
});

voiceprintRoute.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    displayName?: string;
    wavBase64?: string;
    metaInfo?: string;
    roomId?: string; // 对话式注册：带上后成败结果经 ExternalTextToSpeech 播报给房间
    effectiveSec?: number; // 前端能量估算的有效语音秒数（观测样本质量）
    totalSec?: number;
  } | null;
  const tenant = requireTenant(c);
  if (tenant instanceof Response) return tenant;
  const displayName = body?.displayName?.trim();
  const wavBase64 = body?.wavBase64?.trim();
  const roomId = body?.roomId?.trim() || undefined;
  if (!displayName || !wavBase64) {
    return c.json({ ok: false, error: 'displayName + wavBase64 必填' }, 400);
  }
  if (displayName.length > 16) {
    return c.json({ ok: false, error: '名字太长（≤16 字）' }, 400);
  }

  const existing = listActiveVoiceprints(tenant.id);
  const sameName = findByDisplayName(tenant.id, displayName);
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
    if (roomId) reportEnrollFailure(roomId, (err as Error).message);
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
    const record = saveVoiceprint({ voiceprintId, tenantId: tenant.id, audioName, displayName, metaInfo: body?.metaInfo });
    console.log(
      `[voiceprint] registered "${displayName}" id=${voiceprintId} owner=${record.ownerId} dur=${wavInfo.durationSec.toFixed(1)}s` +
        `${body?.effectiveSec != null ? ` effective=${Number(body.effectiveSec).toFixed(1)}s` : ''}${sameName ? ' (重注册)' : ''}${roomId ? ` room=${roomId}` : ''}`,
    );
    if (roomId) {
      completeEnroll(roomId);
      // 新声纹对「当前」房间不生效（IdList 是 StartVoiceChat 时传的）——播报里如实说"下次"。
      speakText(roomId, enrollSuccessLine(displayName), false).catch((err) =>
        console.log(`[voiceprint] 成功播报失败（不阻塞）：${(err as Error).message}`),
      );
    }
    return c.json({ ok: true, voiceprint: record, replaced: sameName?.voiceprintId });
  } catch (err) {
    console.log(`[voiceprint] register failed: ${(err as Error).message}`);
    if (roomId) reportEnrollFailure(roomId, (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

/** 对话式注册失败：还有重试额度 → 让 Javis 请用户再说几句（前端轮询到 recording 会重录）；否则宣告失败。 */
function reportEnrollFailure(roomId: string, error: string): void {
  const retryable = failEnroll(roomId, error);
  speakText(roomId, retryable ? enrollRetryLine() : enrollFailLine(), false).catch((err) =>
    console.log(`[voiceprint] 失败播报失败（不阻塞）：${(err as Error).message}`),
  );
}

voiceprintRoute.get('/list', async (c) => {
  const tenant = requireTenant(c);
  if (tenant instanceof Response) return tenant;
  const local = listActiveVoiceprints(tenant.id);
  if (c.req.query('remote') !== '1') return c.json({ ok: true, voiceprints: local });
  if (!c.get('isAdmin')) return c.json({ ok: true, voiceprints: local }); // 火山全量对账仅 admin
  try {
    const remote = await listVoicePrint();
    return c.json({ ok: true, voiceprints: local, remote });
  } catch (err) {
    return c.json({ ok: true, voiceprints: local, remoteError: (err as Error).message });
  }
});

/** 改显示名（调试面板用）：本地 registry 即时生效（Javis 称呼/记忆归属映射立刻用新名）。 */
voiceprintRoute.post('/rename', async (c) => {
  const tenant = requireTenant(c);
  if (tenant instanceof Response) return tenant;
  const body = (await c.req.json().catch(() => null)) as { voiceprintId?: string; displayName?: string } | null;
  const voiceprintId = body?.voiceprintId?.trim();
  const displayName = body?.displayName?.trim();
  if (!voiceprintId || !displayName) return c.json({ ok: false, error: 'voiceprintId + displayName 必填' }, 400);
  if (displayName.length > 16) return c.json({ ok: false, error: '名字太长（≤16 字）' }, 400);
  const target = getVoiceprint(voiceprintId);
  if (!target || target.tenantId !== tenant.id) return c.json({ ok: false, error: '声纹不存在' }, 404);
  const conflict = findByDisplayName(tenant.id, displayName);
  if (conflict && conflict.voiceprintId !== voiceprintId) {
    return c.json({ ok: false, error: `名字"${displayName}"已被占用` }, 409);
  }
  const record = renameVoiceprint(voiceprintId, displayName);
  if (!record) return c.json({ ok: false, error: '声纹不存在' }, 404);
  // 火山侧 MetaInfo 顺手同步（非关键，失败不阻塞）
  updateVoicePrint({ voicePrintId: voiceprintId, metaInfo: `MyJavis ${displayName}` }).catch((err) =>
    console.log(`[voiceprint] MetaInfo 同步失败（不阻塞）：${(err as Error).message}`),
  );
  console.log(`[voiceprint] renamed id=${voiceprintId} → "${displayName}"`);
  return c.json({ ok: true, voiceprint: record });
});

voiceprintRoute.delete('/:id', async (c) => {
  const tenant = requireTenant(c);
  if (tenant instanceof Response) return tenant;
  const voiceprintId = c.req.param('id')?.trim();
  if (!voiceprintId) return c.json({ ok: false, error: '声纹 ID 必填' }, 400);
  const target = getVoiceprint(voiceprintId);
  if (!target || target.tenantId !== tenant.id) return c.json({ ok: false, error: '声纹不存在' }, 404);
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
