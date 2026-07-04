/**
 * 音乐播放 REST。
 * 主要端点：GET /api/music/pending?roomId=xxx
 * 前端房间激活期间轮询，发现 command 即执行（播放/控制），取走即清。
 */

import { Hono } from 'hono';
import { takePending } from '../music/pending-store.js';

const musicRoute = new Hono();

/** 对话中轮询待执行的音乐指令（play / control）。取件即清空。 */
musicRoute.get('/pending', (c) => {
  const roomId = (c.req.query('roomId') ?? c.req.query('room') ?? '').trim();
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  const command = takePending(roomId);
  return c.json({ command: command ?? null });
});

export { musicRoute };
