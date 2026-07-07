import { Hono } from 'hono';
import { memory } from '../memory/index.js';
import { tenantOwnsOwner } from '../voiceprint/registry.js';
import type { AppEnv } from '../tenant/context.js';
import type { GovernanceResult } from '../memory/types.js';
import type { Context } from 'hono';

const governanceRoute = new Hono<AppEnv>();

// 租户归属校验（批次A）：非 admin 只能治理自己租户声纹派生的 owner（记忆是隐私，红线）。
// reassign 的 targetOwnerId 同校验，防跨租户转移。Hono req.json() 有 bodyCache，端点可重复读。
governanceRoute.use('*', async (c, next) => {
  if (c.get('isAdmin')) {
    await next();
    return;
  }
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { ownerId?: string; targetOwnerId?: string } | null;
  const owners = [c.req.query('owner')?.trim(), body?.ownerId?.trim(), body?.targetOwnerId?.trim()].filter(
    (v): v is string => Boolean(v),
  );
  if (owners.length === 0 || owners.some((o) => !tenantOwnsOwner(tenant.id, o))) {
    return c.json({ ok: false, error: 'owner 不属于当前账号' }, 403);
  }
  await next();
});

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

// R1.1 召回预览（只读）：面板输入一句话 → 看会想起哪些记忆、每条为什么（命中词/来源/得分）。
// 与真实 recall 同一套逻辑（memory-core mixRecall），退化时展示旧路径注入并说明原因。
governanceRoute.get('/recall-preview', async (c) => {
  const ownerId = requiredQuery(c.req.query('owner'));
  const q = (c.req.query('q') ?? '').trim();
  if (!ownerId) return c.json({ ok: false, error: 'owner 必填' }, 400);
  if (!q) return c.json({ ok: false, error: 'q 必填' }, 400);
  const preview = await memory.recallPreview(ownerId, q);
  return c.json({ ok: true, ownerId, query: q, ...preview });
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
