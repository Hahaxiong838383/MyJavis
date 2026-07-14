/**
 * R4 云端异步巩固单测：ephemeral 清理 / 对账收敛 / dormant 冷藏 / 孤儿计数 /
 * profile 重算（即时阈值触发 + 夜间兜底）/ 幂等（R4 验收口径）。
 * 跑法：npm run test:consolidation
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { MemoryConsolidator } from '../src/memory/consolidation.js';
import { _resetConsolidationCounters, noteMemoryWritten } from '../src/memory/consolidation.js';
import { _resetActivity, listActivity } from '../src/activity/feed.js';
import type { MemoryItem } from '../src/memory/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function mkItem(over: Partial<MemoryItem> & { id: string; ownerId: string }): MemoryItem {
  return {
    namespace: `private:${over.ownerId}`,
    type: 'preference',
    content: { kind: 'preference', key: 'preference.drink', value: '喜欢冰美式', source: 'user_said' },
    sourceRole: 'user',
    sourceSpan: '',
    confidence: 0.9,
    status: 'committed',
    createdAt: Date.now(),
    provenance: {},
    acl: {},
    ...over,
  };
}

// —— 1) ephemeral 清理：过期物理删除，未过期/无 validUntil 的保留 ——
{
  const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-consolidation-')), 'memory.db'));
  const now = Date.now();
  storage.insertMemoryItem(
    mkItem({ id: 'eph-expired', ownerId: 'o1', type: 'ephemeral_context', createdAt: now - DAY_MS, validUntil: now - 1000 }),
  );
  storage.insertMemoryItem(
    mkItem({ id: 'eph-fresh', ownerId: 'o1', type: 'ephemeral_context', createdAt: now, validUntil: now + DAY_MS }),
  );
  storage.insertMemoryItem(mkItem({ id: 'eph-no-ttl', ownerId: 'o1', type: 'ephemeral_context', createdAt: now }));

  const consolidator = new MemoryConsolidator(storage);
  const report = await consolidator.runOnce(now);
  assert.equal(report.ephemeralDeleted, 1, `只删过期的一条，实际 ${report.ephemeralDeleted}`);
  assert.equal(storage.getMemoryItem('eph-expired'), undefined, '过期 ephemeral 应物理删除');
  assert.ok(storage.getMemoryItem('eph-fresh'), '未过期 ephemeral 应保留');
  assert.ok(storage.getMemoryItem('eph-no-ttl'), '无 validUntil 的 ephemeral 不应被清理');
  storage.close();
  console.log('✓ ephemeral 清理');
}

// —— 2) 对账：validUntil 已过但 invalid_at 未收敛的条目回填；未过期的不动 ——
{
  const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-consolidation-')), 'memory.db'));
  const now = Date.now();
  storage.insertMemoryItem(
    mkItem({ id: 'evt-expired', ownerId: 'o1', type: 'event', content: { kind: 'event', key: 'event.trip', value: '过期行程', source: 'user_said' }, createdAt: now - DAY_MS, validUntil: now - 1000 }),
  );
  storage.insertMemoryItem(
    mkItem({ id: 'evt-fresh', ownerId: 'o1', type: 'event', content: { kind: 'event', key: 'event.trip2', value: '未来行程', source: 'user_said' }, createdAt: now, validUntil: now + DAY_MS }),
  );

  const consolidator = new MemoryConsolidator(storage);
  const report = await consolidator.runOnce(now);
  assert.equal(report.reconciled, 1, `只收敛过期的一条，实际 ${report.reconciled}`);

  const row = storage.db.prepare('SELECT invalid_at FROM memory_item WHERE id = ?').get('evt-expired') as { invalid_at: number | null };
  assert.ok(row.invalid_at, '过期条目 invalid_at 应被回填');
  const freshRow = storage.db.prepare('SELECT invalid_at FROM memory_item WHERE id = ?').get('evt-fresh') as { invalid_at: number | null };
  assert.equal(freshRow.invalid_at, null, '未过期条目 invalid_at 不应被动');

  // 治理面板路径（listMemoriesByOwner，不走 hot 视图）过期前仍会显示该条——收敛后 invalid_at
  // 有值，是 hot 视图之外唯一能感知"已失效"的信号（MemoryItem 类型未暴露该字段，故查原始列）。
  assert.ok(storage.listOwnerMemories('o1', 20).some((item) => item.id === 'evt-expired'), '物理保留，未被删除（仅回填时间戳）');
  storage.close();
  console.log('✓ 对账收敛');
}

// —— 3) dormant 冷藏：长期未强化的 preference 标记冷藏且检索不再扫；新近的不受影响 ——
{
  const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-consolidation-')), 'memory.db'));
  const now = Date.now();
  storage.insertMemoryItem(
    mkItem({
      id: 'pref-stale',
      ownerId: 'o1',
      content: { kind: 'preference', key: 'preference.drink', value: '很久没提过的偏好', source: 'user_said' },
      createdAt: now - 40 * DAY_MS,
    }),
  );
  storage.insertMemoryItem(
    mkItem({
      id: 'pref-recent',
      ownerId: 'o1',
      content: { kind: 'preference', key: 'preference.music', value: '最近提过的偏好', source: 'user_said' },
      createdAt: now - DAY_MS,
    }),
  );

  const consolidator = new MemoryConsolidator(storage);
  const report = await consolidator.runOnce(now);
  assert.equal(report.dormantMarked, 1, `只冷藏 40 天前那条，实际 ${report.dormantMarked}`);

  const staleRow = storage.db.prepare('SELECT dormant FROM memory_item WHERE id = ?').get('pref-stale') as { dormant: number };
  assert.equal(staleRow.dormant, 1, '陈旧偏好应被标记 dormant');
  const recentRow = storage.db.prepare('SELECT dormant FROM memory_item WHERE id = ?').get('pref-recent') as { dormant: number };
  assert.equal(recentRow.dormant, 0, '近期偏好不应被冷藏');

  const hot = storage.listHotMemories('o1', 20).map((item) => item.id);
  assert.ok(!hot.includes('pref-stale'), 'dormant 条目检索不再可见');
  assert.ok(hot.includes('pref-recent'), '未冷藏条目仍可召回');
  assert.equal(storage.getMemoryItem('pref-stale')?.dormant, true, '物理保留（不删），MemoryItem.dormant 反映状态');
  storage.close();
  console.log('✓ dormant 冷藏 + 检索过滤');
}

// —— 4) 孤儿数据：只计数不删除 ——
{
  const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-consolidation-')), 'memory.db'));
  const now = Date.now();
  storage.insertMemoryItem(mkItem({ id: 'orphan-1', ownerId: 'owner_ghost', createdAt: now }));
  storage.insertMemoryItem(mkItem({ id: 'known-1', ownerId: 'owner_known', createdAt: now }));

  const consolidator = new MemoryConsolidator(storage, (ownerId) => (ownerId === 'owner_known' ? 'tn-known' : undefined));
  const report = await consolidator.runOnce(now);
  assert.equal(report.orphanMemoryCount, 1, `只有 owner_ghost 是孤儿，实际 ${report.orphanMemoryCount}`);
  assert.ok(storage.getMemoryItem('orphan-1'), '孤儿数据物理保留（不自动删）');
  storage.close();
  console.log('✓ 孤儿数据只计数不删除');
}

// —— 5) profile 重算：即时阈值触发（满 50 条）+ 夜间兜底（无论计数器，全量重算） ——
{
  _resetConsolidationCounters();
  _resetActivity();
  const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-consolidation-')), 'memory.db'));
  const now = Date.now();
  storage.insertMemoryItem(
    mkItem({ id: 'pref-a', ownerId: 'o-profile', content: { kind: 'preference', key: 'preference.drink', value: '喜欢冰美式', source: 'user_said' }, createdAt: now }),
  );
  assert.equal(storage.listPrefSummaries('o-profile').length, 0, '重算前无 pref_summary');

  for (let i = 0; i < 49; i++) noteMemoryWritten('o-profile', storage, 'tn-profile');
  assert.equal(storage.listPrefSummaries('o-profile').length, 0, '未满 50 条不应触发即时重算');

  noteMemoryWritten('o-profile', storage, 'tn-profile'); // 第 50 次
  const summaries = storage.listPrefSummaries('o-profile');
  assert.equal(summaries.length, 1, '满 50 条应立即重算触发');
  assert.equal(summaries[0]!.currentValue, '喜欢冰美式');
  assert.ok(listActivity('tn-profile').some((e) => e.kind === 'consolidation'), '即时重算应产生 consolidation 活动事件');

  // 夜间兜底：即使计数器已清零（刚触发过），runOnce 仍无条件重算一遍（内容不变，幂等）。
  const consolidator = new MemoryConsolidator(storage);
  const report = await consolidator.runOnce(now);
  assert.ok(report.profileOwnersRecomputed >= 1, '夜间批处理应覆盖到该 owner');
  assert.equal(storage.listPrefSummaries('o-profile')[0]!.currentValue, '喜欢冰美式', '兜底重算结果与即时重算一致');
  storage.close();
  console.log('✓ profile 重算（即时阈值 + 夜间兜底）');
}

// —— 6) 幂等：同一轮 runOnce 连续跑两遍，第二遍对已收敛条目零新增变化，DB 终态一致 ——
{
  const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-consolidation-')), 'memory.db'));
  const now = Date.now();
  storage.insertMemoryItem(
    mkItem({ id: 'idem-eph', ownerId: 'o-idem', type: 'ephemeral_context', createdAt: now - DAY_MS, validUntil: now - 1000 }),
  );
  storage.insertMemoryItem(
    mkItem({ id: 'idem-evt', ownerId: 'o-idem', type: 'event', content: { kind: 'event', key: 'event.x', value: '过期事件', source: 'user_said' }, createdAt: now - DAY_MS, validUntil: now - 1000 }),
  );
  storage.insertMemoryItem(
    mkItem({ id: 'idem-pref-stale', ownerId: 'o-idem', content: { kind: 'preference', key: 'preference.drink', value: '陈旧偏好', source: 'user_said' }, createdAt: now - 40 * DAY_MS }),
  );
  storage.insertMemoryItem(
    mkItem({ id: 'idem-pref-b', ownerId: 'o-idem', content: { kind: 'preference', key: 'preference.snack', value: '喜欢薯片', source: 'user_said' }, createdAt: now }),
  );

  const consolidator = new MemoryConsolidator(storage);
  const run1 = await consolidator.runOnce(now);
  const snapshot1 = {
    items: storage.listOwnerMemories('o-idem', 50).map((i) => ({ id: i.id, dormant: i.dormant })),
    prefs: storage.listPrefSummaries('o-idem'),
  };

  const run2 = await consolidator.runOnce(now); // 同一个 now，紧接着再跑一轮
  const snapshot2 = {
    items: storage.listOwnerMemories('o-idem', 50).map((i) => ({ id: i.id, dormant: i.dormant })),
    prefs: storage.listPrefSummaries('o-idem'),
  };

  assert.equal(run1.ephemeralDeleted, 1);
  assert.equal(run2.ephemeralDeleted, 0, '第二轮无新增 ephemeral 可删');
  assert.equal(run1.reconciled, 1);
  assert.equal(run2.reconciled, 0, '第二轮无新增待收敛条目');
  assert.equal(run1.dormantMarked, 1);
  assert.equal(run2.dormantMarked, 0, '第二轮无新增待冷藏条目（已冷藏的被 dormant=0 过滤条件天然排除）');
  assert.equal(run1.profileOwnersRecomputed, run2.profileOwnersRecomputed, 'profile 重算两轮触达的 owner 数一致');
  assert.deepEqual(snapshot2, snapshot1, '两轮之后 DB 终态完全一致（幂等）');
  storage.close();
  console.log('✓ 幂等：runOnce 连续两轮 DB 终态一致');
}

console.log('✅ consolidation.test.ts 全部通过（ephemeral/对账/dormant/孤儿/profile重算/幂等）');
