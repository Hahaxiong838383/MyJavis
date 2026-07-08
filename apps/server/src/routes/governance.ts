import { Hono } from 'hono';
import { memory, storage } from '../memory/index.js';
import { listActivity } from '../activity/feed.js';
import { listActiveVoiceprints, soloOwnerId, tenantOwnsOwner } from '../voiceprint/registry.js';
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
  // tenant 级端点（无 owner 参数语义）：有租户上下文即放行
  if (c.req.path.endsWith('/activity') || c.req.path.endsWith('/owners') || c.req.path.endsWith('/conversations')) {
    await next();
    return;
  }
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

// R3 记忆活动流（川哥要求：运行机制和状态 App 实时可见）：tenant 级最近 50 条事件。
// 放归属中间件之后但按 tenant 取（无需 owner 参数）；admin 无租户上下文时返回空。
governanceRoute.get('/activity', (c) => {
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: true, events: [] });
  return c.json({ ok: true, events: listActivity(tenant.id) });
});

// R3.5 owners 列表（面板"owner 点选"）：solo 默认 owner（恒在首位）+ 该租户声纹表全部 owner。
// 单人模式下声纹 owner 永远 0 条记忆（记忆全归 solo owner）——0 记忆的声纹条目不返回，
// 否则同一个人在面板出现两个名字（川哥实测困惑 2026-07-08）。家庭模式历史记忆（>0）仍显示。
governanceRoute.get('/owners', (c) => {
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: true, owners: [] });
  const solo = {
    ownerId: soloOwnerId(tenant.id),
    displayName: tenant.userTitle || '我',
    source: 'solo' as const,
    memoryCount: storage.countMemoriesByOwner(soloOwnerId(tenant.id)),
  };
  const voiceprintOwners = listActiveVoiceprints(tenant.id)
    .map((vp) => ({
      ownerId: vp.ownerId,
      displayName: vp.displayName,
      source: 'voiceprint' as const,
      memoryCount: storage.countMemoriesByOwner(vp.ownerId),
    }))
    .filter((o) => !tenant.soloMode || o.memoryCount > 0);
  return c.json({ ok: true, owners: [solo, ...voiceprintOwners] });
});

// R3.5 对话历史面板：按租户取最近对话（event_log tenant_id 迁移前的老行不返回，见 storage.ts 注释）。
governanceRoute.get('/conversations', (c) => {
  const tenant = c.get('tenant');
  if (!tenant) return c.json({ ok: true, conversations: [] });
  const limit = Math.min(200, Number(c.req.query('limit') ?? 50) || 50);
  const events = storage.listEventsByTenant(tenant.id, limit);
  return c.json({
    ok: true,
    conversations: events.map((e) => ({
      id: e.id,
      roomId: e.roomId,
      sourceRole: e.sourceRole,
      utteranceText: e.utteranceText,
      createdAt: e.createdAt,
    })),
  });
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
