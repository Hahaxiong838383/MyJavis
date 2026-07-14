/**
 * R4 云端异步巩固（docs/memory-architecture.md §5.2「异步巩固」+ §6 R4）。
 *
 * 定位：ROADMAP P3 Autodreaming 轻量版落地——夜间对账批处理（ephemeral 清理 / dormant
 * 冷藏 / bi-temporal 收敛 / 孤儿数据计数）+ profile 画像重算触发。全部巩固动作异步批处理，
 * 绝不进通话热路径——唯一热路径 touchpoint 是 noteMemoryWritten 的 O(1) 计数器自增
 * （见 memory/index.ts remember() 里的调用点），不做任何 I/O。
 *
 * 幂等契约（R4 验收口径，见 scripts/consolidation.test.ts）：runOnce() 连续跑两轮，
 * 第二轮对已收敛的条目零新增变化——
 *   - ephemeral 清理：物理删除后第二轮查无可删；
 *   - 对账：复用 invalidateMemoryItems 的 "invalid_at IS NULL" guard，已收敛的不重复；
 *   - dormant 冷藏：listDormantCandidates 天然过滤 dormant=0，已冷藏的不再入选；
 *   - profile 重算：纯函数式重算（由现有记忆状态确定性推导），重复执行输出不变。
 */
import { pushActivity } from '../activity/feed.js';
import { config } from '../config.js';
import type { SQLiteMemoryStorage } from './storage.js';

/** 巩固批处理"是否到点"扫描粒度（不是跑批间隔本身——跑批仍是每天一次，见 checkTick）。 */
const CHECK_TICK_MS = Number(process.env.CONSOLIDATION_CHECK_TICK_MS ?? 10 * 60_000);

/**
 * dormant 冷藏 staleness 阈值：30 天未被强化/新建。
 * 依据：OpenViking 的 hotness 冷藏模型用 7 天半衰期（docs/memory-architecture.md §2.6），
 * 但那是面向企业级高频客服场景；MyJavis 是个人/家庭语音助手，对话频率低得多，
 * 30 天没提起仍完全可能是真实稳定的偏好（"喜欢喝美式"不需要每周重复才算数）。
 * dormant 只影响检索候选池扫描（不删除、可恢复），选保守阈值把"过早冷藏合法记忆"
 * 的体验风险降到最低，同时仍能演示冷藏机制本身工作正常。
 */
const DORMANT_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** profile 重算触发阈值：腾讯管线节奏移植（docs/memory-architecture.md §2.1"每 50 条新记忆触发 L3 画像重算"）。 */
const PROFILE_RECOMPUTE_THRESHOLD = 50;

/** owner → 自上次重算后新增记忆计数（内存态；重启丢失由夜间批处理兜底全量重算，见 runOnce）。 */
const newMemoryCounters = new Map<string, number>();

export interface ConsolidationReport {
  ephemeralDeleted: number;
  reconciled: number;
  dormantMarked: number;
  profileOwnersRecomputed: number;
  orphanMemoryCount: number;
}

/**
 * remember() 写入成功后的钩子（memory/index.ts 热路径内唯一 touchpoint）：O(1) 计数器
 * 自增，不做任何 I/O；满 50 条立即重算该 owner 的 pref_summary（不等夜间批处理，
 * 保持画像新鲜度）。夜间批处理仍会无条件全量重算一遍兜底（见 MemoryConsolidator.runOnce），
 * 所以重启丢计数最多导致画像"迟到一晚"变新，而非永久卡住。
 */
export function noteMemoryWritten(ownerId: string, db: SQLiteMemoryStorage, tenantId?: string): void {
  const next = (newMemoryCounters.get(ownerId) ?? 0) + 1;
  if (next < PROFILE_RECOMPUTE_THRESHOLD) {
    newMemoryCounters.set(ownerId, next);
    return;
  }
  newMemoryCounters.set(ownerId, 0);
  const recomputed = recomputeAllPrefSummaries(db, ownerId);
  if (recomputed > 0) {
    pushActivity(tenantId, {
      kind: 'consolidation',
      summary: `画像已刷新：${recomputed} 个偏好维度重算（累计新增满 ${PROFILE_RECOMPUTE_THRESHOLD} 条记忆触发）`,
      detail: { dimensions: recomputed },
    });
  }
}

/**
 * 重算某 owner 全部 preference 维度的 pref_summary。逻辑与 memory/index.ts 私有方法
 * recomputePrefSummary 等价（同过滤条件：type=preference/非 quarantine/非 suspended，
 * 取最近 5 条），刻意未抽成两边共享的导出函数以避免 consolidation.ts ↔ memory/index.ts
 * 相互 import 成环——两处各自维护同一段 ~10 行逻辑，是本切片的一处工程取舍
 * （见 R4 完成报告"未决问题/工程决定"）。
 */
export function recomputeAllPrefSummaries(db: SQLiteMemoryStorage, ownerId: string, now = Date.now()): number {
  const dimensions = new Set(
    db
      .listMemoriesByOwner(ownerId, 2000)
      .filter((item) => item.type === 'preference')
      .map((item) => item.content.key),
  );
  for (const dimension of dimensions) recomputePrefSummaryDimension(db, ownerId, dimension, now);
  return dimensions.size;
}

/**
 * now 显式透传（而非在函数体内各自调 Date.now()）：runOnce(now) 的其余步骤（ephemeral 清理/
 * 对账/dormant 阈值）全部以调用方注入的 now 为准，pref_summary 的 updatedAt 若各自取真实
 * 挂钟时间，会让"同一轮 now 跑两遍"在毫秒边界上产生不同的 updatedAt——这不是内容不一致，
 * 但会让幂等断言（DB 终态深比较）产生误报。统一以 now 为准后，两次调用真正字节级一致。
 */
function recomputePrefSummaryDimension(db: SQLiteMemoryStorage, ownerId: string, dimension: string, now: number): void {
  const active = db
    .listMemoryByDimension(ownerId, dimension, 20)
    .filter((item) => item.type === 'preference' && item.status !== 'quarantine' && !item.suspended)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
    .map((item) => ({ memoryId: item.id, value: item.content.value, ts: item.createdAt }));
  if (active.length === 0) {
    db.deletePrefSummary(ownerId, dimension);
    return;
  }
  db.upsertPrefSummary({ ownerId, dimension, currentValue: active[0]!.value, activeConditions: active, updatedAt: now });
}

export class MemoryConsolidator {
  private timer: NodeJS.Timeout | null = null;
  private lastRunDateKey: string | null = null;
  private running = false;

  constructor(
    private readonly db: SQLiteMemoryStorage,
    /** ownerId → tenantId 反解（voiceprint/registry.ts tenantForOwner）：孤儿判定 + 冷藏活动事件归属。 */
    private readonly tenantForOwner: (ownerId: string) => string | undefined = () => undefined,
  ) {}

  start(): void {
    if (!config.memoryConsolidation.enabled) {
      console.log('[consolidation] disabled (CONSOLIDATION_ENABLED=0)');
      return;
    }
    this.timer = setInterval(
      () => void this.checkTick().catch((err) => console.error('[consolidation] tick error:', err)),
      CHECK_TICK_MS,
    );
    this.timer.unref?.(); // 不阻止进程退出（测试/优雅停机）
    console.log(
      `[consolidation] scheduler started (daily @ ${config.memoryConsolidation.hour}:00 local, check every ${Math.round(CHECK_TICK_MS / 60_000)}min)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 是否到点且今天还没跑过；到点则跑一轮（供 setInterval 调用，测试请直调 runOnce）。 */
  private async checkTick(now = Date.now()): Promise<void> {
    const d = new Date(now);
    if (d.getHours() !== config.memoryConsolidation.hour) return;
    const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (this.lastRunDateKey === dateKey) return; // 今天已跑过
    this.lastRunDateKey = dateKey;
    await this.runOnce(now);
  }

  /** 一轮夜间对账（测试/运维可直调，幂等——见文件头注释）。 */
  async runOnce(now = Date.now()): Promise<ConsolidationReport> {
    if (this.running) {
      // 上一轮未完成（不应发生在测试直调场景，防御生产偶发重入）：跳过返回零报告。
      return { ephemeralDeleted: 0, reconciled: 0, dormantMarked: 0, profileOwnersRecomputed: 0, orphanMemoryCount: 0 };
    }
    this.running = true;
    try {
      // a) ephemeral 清理：working 层是当日弃用草稿，物理删除。
      const ephemeralDeleted = this.db.deleteExpiredEphemeral(now);

      // c) 对账：validUntil 已过但从未被冲突流程标记 invalid 的条目，回填 bi-temporal 收敛
      // （治理面板 listByOwner/exportOwner 不走 hot 视图，否则会一直显示"看似仍生效"）。
      const reconciled = this.db.reconcileExpiredValidity(now);

      // 孤儿数据（owner 反解不到任何租户，'unattributed' 特殊值除外）：只计数告警不自动删——
      // 可能是租户配置临时缺失而非真孤儿，删除需人工介入（数据治理红线）。
      const orphanMemoryCount = this.countOrphans();
      if (orphanMemoryCount > 0) {
        console.log(`[consolidation] orphan memories detected: ${orphanMemoryCount}（未自动清理，需人工核实）`);
      }

      // b) dormant 冷藏：低 salience 的 semantic 条目（长期未强化/新建）→ 标记不删，检索不再扫。
      const staleBefore = now - DORMANT_STALE_MS;
      const candidates = this.db.listDormantCandidates(staleBefore);
      const dormantByTenant = new Map<string, number>();
      for (const item of candidates) {
        if (this.db.setMemoryDormant(item.id, true)) {
          const tenantId = this.tenantForOwner(item.ownerId);
          if (tenantId) dormantByTenant.set(tenantId, (dormantByTenant.get(tenantId) ?? 0) + 1);
        }
      }
      for (const [tenantId, count] of dormantByTenant) {
        pushActivity(tenantId, {
          kind: 'consolidation',
          summary: `${count} 条长期未提及的记忆已冷藏（检索将跳过，未删除，可在治理面板恢复）`,
          detail: { count },
        });
      }

      // profile 重算兜底：不论内存计数器状态如何，夜间无条件全量重算一遍 + 计数器清零
      // （重启丢计数的安全网——见 noteMemoryWritten 头注）。
      let profileOwnersRecomputed = 0;
      for (const ownerId of this.db.listOwnerIdsWithMemories()) {
        newMemoryCounters.set(ownerId, 0);
        if (recomputeAllPrefSummaries(this.db, ownerId, now) > 0) profileOwnersRecomputed += 1;
      }

      console.log(
        `[consolidation] run complete: ephemeralDeleted=${ephemeralDeleted} reconciled=${reconciled} ` +
          `dormantMarked=${candidates.length} profileOwnersRecomputed=${profileOwnersRecomputed} orphans=${orphanMemoryCount}`,
      );
      return {
        ephemeralDeleted,
        reconciled,
        dormantMarked: candidates.length,
        profileOwnersRecomputed,
        orphanMemoryCount,
      };
    } finally {
      this.running = false;
    }
  }

  private countOrphans(): number {
    let orphans = 0;
    for (const ownerId of this.db.listOwnerIdsWithMemories()) {
      if (ownerId === 'unattributed') continue; // 已知特殊值（身份未识别兜底桶），非孤儿
      if (!this.tenantForOwner(ownerId)) orphans += this.db.countMemoriesByOwner(ownerId);
    }
    return orphans;
  }
}

/** 测试专用：清空 profile 重算计数器内存态（防并行测试用例串扰）。 */
export function _resetConsolidationCounters(): void {
  newMemoryCounters.clear();
}
