import { Hono } from 'hono';
import { memory } from '../memory/index.js';
import type { GovernanceResult } from '../memory/types.js';
import type { Context } from 'hono';

const governanceRoute = new Hono();

governanceRoute.get('/', async (c) => {
  const ownerId = requiredQuery(c.req.query('owner'));
  if (!ownerId) return c.json({ ok: false, error: 'owner 必填' }, 400);
  const memories = await memory.listByOwner(ownerId);
  return c.json({ ok: true, ownerId, memories });
});

governanceRoute.get('/export', async (c) => {
  const ownerId = requiredQuery(c.req.query('owner'));
  if (!ownerId) return c.json({ ok: false, error: 'owner 必填' }, 400);
  const payload = await memory.exportOwner(ownerId);
  return c.json({ ok: true, export: payload });
});

governanceRoute.post('/suspend', async (c) => {
  const body = await parseOwnerMemoryBody(c.req.json.bind(c.req));
  if (!body) return c.json({ ok: false, error: 'ownerId + memoryId 必填' }, 400);
  return resultJson(c, await memory.suspend(body.ownerId, body.memoryId));
});

governanceRoute.post('/resume', async (c) => {
  const body = await parseOwnerMemoryBody(c.req.json.bind(c.req));
  if (!body) return c.json({ ok: false, error: 'ownerId + memoryId 必填' }, 400);
  return resultJson(c, await memory.resume(body.ownerId, body.memoryId));
});

governanceRoute.post('/reassign', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ownerId?: string; memoryId?: string; targetOwnerId?: string } | null;
  if (!body?.ownerId?.trim() || !body.memoryId?.trim() || !body.targetOwnerId?.trim()) {
    return c.json({ ok: false, error: 'ownerId + memoryId + targetOwnerId 必填' }, 400);
  }
  return resultJson(c, await memory.reassign(body.ownerId.trim(), body.memoryId.trim(), body.targetOwnerId.trim()));
});

governanceRoute.delete('/:memoryId', async (c) => {
  const ownerId = requiredQuery(c.req.query('owner'));
  const memoryId = requiredQuery(c.req.param('memoryId'));
  if (!ownerId || !memoryId) return c.json({ ok: false, error: 'owner + memoryId 必填' }, 400);
  return resultJson(c, await memory.delete(ownerId, memoryId));
});

governanceRoute.delete('/', async (c) => {
  const body = await parseOwnerMemoryBody(c.req.json.bind(c.req));
  if (!body) return c.json({ ok: false, error: 'ownerId + memoryId 必填' }, 400);
  return resultJson(c, await memory.delete(body.ownerId, body.memoryId));
});

export { governanceRoute };

function requiredQuery(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function parseOwnerMemoryBody(readJson: () => Promise<unknown>): Promise<{ ownerId: string; memoryId: string } | null> {
  const body = (await readJson().catch(() => null)) as { ownerId?: string; memoryId?: string } | null;
  const ownerId = body?.ownerId?.trim();
  const memoryId = body?.memoryId?.trim();
  return ownerId && memoryId ? { ownerId, memoryId } : null;
}

function resultJson(c: Context, result: GovernanceResult): Response | Promise<Response> {
  if (result.ok) return c.json({ ok: true, memoryId: result.memoryId });
  if (result.reason === 'cross_owner_rejected') return c.json({ ok: false, error: result.reason, memoryId: result.memoryId }, 403);
  if (result.reason === 'not_found') return c.json({ ok: false, error: result.reason, memoryId: result.memoryId }, 404);
  return c.json({ ok: false, error: result.reason ?? 'governance_failed', memoryId: result.memoryId }, 400);
}
