import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { activePublicVoicePolicyCount } from '../public-voice/policy.js';
import { startPublicVoiceSession, stopPublicVoiceSession } from './rtc.js';

const publicVoiceRoute = new Hono();

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

publicVoiceRoute.use('*', async (c, next) => {
  const expected = process.env.PUBLIC_VOICE_SHARED_SECRET?.trim();
  const supplied = c.req.header('x-public-voice-secret')?.trim() ?? '';
  if (!expected || !supplied || !secureEqual(supplied, expected)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  await next();
});

publicVoiceRoute.get('/status', (c) =>
  c.json({
    ok: true,
    enabled: (process.env.PUBLIC_VOICE_ENABLED ?? '0') === '1',
    activeSessions: activePublicVoicePolicyCount(),
  }),
);

publicVoiceRoute.post('/start', async (c) => {
  if ((process.env.PUBLIC_VOICE_ENABLED ?? '0') !== '1') {
    return c.json({ ok: false, error: 'public_voice_disabled' }, 503);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    systemPrompt?: unknown;
    promptVersion?: unknown;
    maxSeconds?: unknown;
  };
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
  if (systemPrompt.length < 80 || systemPrompt.length > 12_000) {
    return c.json({ ok: false, error: 'invalid_system_prompt' }, 400);
  }
  const promptVersion =
    typeof body.promptVersion === 'string' && body.promptVersion.trim()
      ? body.promptVersion.trim().slice(0, 80)
      : 'site-unknown';
  const configuredSeconds = Number(process.env.PUBLIC_VOICE_MAX_SECONDS ?? 120);
  const requestedSeconds = Number(body.maxSeconds ?? configuredSeconds);
  const maxSeconds = Math.max(30, Math.min(configuredSeconds, requestedSeconds, 180));

  try {
    const session = await startPublicVoiceSession({ systemPrompt, promptVersion, maxSeconds });
    return c.json({ ok: true, ...session });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'public_voice_busy' ? 429 : 502;
    return c.json({ ok: false, error: message }, status);
  }
});

publicVoiceRoute.post('/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: unknown };
  const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
  if (!roomId) return c.json({ ok: false, error: 'roomId_required' }, 400);
  const stopped = await stopPublicVoiceSession(roomId, 'site-request');
  return c.json({ ok: stopped });
});

export { publicVoiceRoute };
