/**
 * R4 提炼代理端点（docs/memory-architecture.md §4.4，多租户，X-Javis-Key 中间件已在 index.ts 挂全局）。
 *
 *   POST /api/memory/refine   App vault 批次 → server 转发 LLM → 结构化 ADD/UPDATE/DELETE/NONE 决策
 *
 * 鉴权：走全局 X-Javis-Key 中间件 + effectiveTenant（同 reminders/privacy 模式），无租户 403。
 * 隐私红线：本路由全程零落盘——不落 DB、不落文件；日志只记条数/耗时/租户前缀，绝不记内容
 *（若要 grep 复核，见下方 console.log 调用点，参数里没有 item.value / item.key 原文）。
 * 失败契约：LLM 失败/超时返回 502 + error 码，App 侧保留批次原样重试（降级档语义，
 * 短期/中期/情景层完全不受影响，因为它们本就走纯规则写入，不依赖本端点）。
 */
import { Hono } from 'hono';
import { effectiveTenant, type AppEnv } from '../tenant/context.js';
import { config } from '../config.js';
import { createLlm } from '../providers/llm.js';
import { MAX_REFINE_BATCH_ITEMS, refineBatch, type RefineBatchItem } from '../memory/refine-proxy.js';

const memoryRefineRoute = new Hono<AppEnv>();

memoryRefineRoute.post('/refine', async (c) => {
  if (!config.memoryRefineProxy.enabled) return c.json({ ok: false, error: 'refine proxy disabled' }, 503);
  const tenant = effectiveTenant(c);
  if (!tenant) return c.json({ ok: false, error: 'no tenant' }, 403);

  const body = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
  const rawItems = Array.isArray(body?.items) ? body.items : null;
  if (!rawItems) return c.json({ ok: false, error: 'items 必填（数组）' }, 400);
  if (rawItems.length > MAX_REFINE_BATCH_ITEMS) {
    return c.json({ ok: false, error: `单批最多 ${MAX_REFINE_BATCH_ITEMS} 条` }, 413);
  }

  const items: RefineBatchItem[] = [];
  const seenIds = new Set<number>();
  for (const raw of rawItems) {
    const r = raw as Record<string, unknown>;
    if (typeof r?.id !== 'number' || !Number.isInteger(r.id)) {
      return c.json({ ok: false, error: 'item.id 必须是整数' }, 400);
    }
    if (r.role !== 'pending' && r.role !== 'context') {
      return c.json({ ok: false, error: 'item.role 必须是 pending 或 context' }, 400);
    }
    if (typeof r.type !== 'string' || typeof r.key !== 'string' || typeof r.value !== 'string' || !r.value.trim()) {
      return c.json({ ok: false, error: 'item.type/key/value 必须是非空字符串' }, 400);
    }
    if (seenIds.has(r.id)) return c.json({ ok: false, error: 'item.id 批次内必须唯一' }, 400);
    seenIds.add(r.id);
    items.push({ id: r.id, role: r.role, type: r.type, key: r.key, value: r.value });
  }

  const pendingCount = items.filter((item) => item.role === 'pending').length;
  const started = performance.now();
  try {
    const decisions = await refineBatch(items, createLlm());
    const elapsed = Math.round(performance.now() - started);
    console.log(
      `[memory-refine] tenant=${tenant.id.slice(0, 8)} pending=${pendingCount} context=${items.length - pendingCount} ` +
        `decisions=${decisions.length} elapsed=${elapsed}ms`,
    );
    return c.json({ ok: true, decisions });
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[memory-refine] tenant=${tenant.id.slice(0, 8)} pending=${pendingCount} FAILED elapsed=${elapsed}ms: ${message.slice(0, 160)}`);
    return c.json({ ok: false, error: 'llm_failed' }, 502);
  }
});

export { memoryRefineRoute };
