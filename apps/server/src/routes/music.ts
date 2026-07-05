/**
 * 音乐播放 REST。
 * - GET  /api/music/pending?roomId=   前端轮询待执行指令（语音链路），取件即清
 * - POST /api/music/next {roomId}     换一首（按钮直调，同步返回新歌 command 不走轮询省 2s）
 * - GET  /api/music/guard-config      守护计费模式下发（server env 控，改模式不用重发 App）
 */

import { Hono } from 'hono';
import { takePending } from '../music/pending-store.js';
import { getMusicSession, recordPlay } from '../music/music-session.js';
import { musicPlay } from '../music/orchestrator-client.js';
import { buildStreamUrl } from '../music/stream-url.js';

const musicRoute = new Hono();

/** 对话中轮询待执行的音乐指令（play / control）。取件即清空。 */
musicRoute.get('/pending', (c) => {
  const roomId = (c.req.query('roomId') ?? c.req.query('room') ?? '').trim();
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  const command = takePending(roomId);
  // 只在真正送达指令时打日志（轮询每 2s 一次，不打空轮询防刷屏）
  if (command) {
    console.log(`[music-pending] DELIVER room=${roomId} ${command.action} ${'streamUrl' in command ? command.streamUrl.slice(0, 60) : command.control}`);
  }
  return c.json({ command: command ?? null });
});

/** 换一首：复用语音链路同一套换歌逻辑（上次查询 + 排除已放），同步返回新歌。 */
musicRoute.post('/next', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string };
  const roomId = body.roomId?.trim();
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  const ms = getMusicSession(roomId);
  if (!ms?.lastQuery) return c.json({ ok: false, error: 'no_session' }, 404);
  const playRes = await musicPlay(ms.lastQuery, roomId, ms.playedIds);
  if (playRes?.status === 'playing' && playRes.track) {
    const track = playRes.track;
    const fullUrl = buildStreamUrl(playRes.stream_url || track.stream_url || '');
    if (fullUrl) {
      recordPlay(roomId, ms.lastQuery, track.id);
      console.log(`[music] next room=${roomId} → "${track.title.slice(0, 30)}"`);
      return c.json({ ok: true, command: { action: 'play', streamUrl: fullUrl, title: track.title } });
    }
  }
  return c.json({ ok: false, error: playRes?.status ?? 'unavailable' }, 502);
});

/** 守护计费模式（D1 拍板 C：开关双实现默认省钱）。respond=挂任务静音 / save=停任务省钱。 */
musicRoute.get('/guard-config', (c) => {
  const mode = process.env.MUSIC_GUARD_MODE === 'respond' ? 'respond' : 'save';
  return c.json({ mode });
});

export { musicRoute };
