import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';
import type { MemoryItem } from '../src/memory/types.js';

// R1 召回相关性化集成测试：真实 remember 写入 → recall 召回，
// 核心对照 = 目标记忆被 12 条新记忆挤出"最近 8 条"后，旧逻辑必挂、新逻辑必过。

const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-recall-')), 'memory.db'));
const memory = new MyJavisMemory(storage, new EventLog(storage));
const identity = new VolcIdentityProvider(storage);
const resolved = identity.resolve({ roomId: 'recall', voiceprintId: 'vp_recall', score: 0.95 });
const ownerId = resolved.ownerId!;

// 1) 目标记忆走真实链路写入（safety 类，抽取/准入全真）
await memory.remember({
  roomId: 'recall',
  ownerId,
  identity: resolved,
  utterance: '我对青霉素过敏',
  sourceRole: 'user',
  isFinal: true,
});
const target = storage.listOwnerMemories(ownerId, 20).find((item) => item.type === 'safety');
assert.ok(target, '目标 safety 记忆应落库');
assert.equal(target!.status, 'committed');

// 2) 灌 12 条互不相关、时间在目标之后的 event 记忆（storage 层直插——写入链路已被
//    lifecycle/storage 测试覆盖，这里只为把目标挤出"最近 N 条"窗口，模拟目标被后续
//    话题淹没；内容刻意与"青霉素/过敏"零词重叠。created_at 不可变列，故用"目标先说、
//    闲聊后说"的时间序而非拨旧目标；半衰期衰减已由 memory-core 单测覆盖）
const topics = ['航班值机', '快递取件', '球赛比分', '汇率牌价', '路况拥堵', '菜谱做法', '电影场次', '油价调整', '球鞋清洗', '空调维修', '花园浇水', '手机换膜'];
for (let i = 0; i < topics.length; i++) {
  const item: MemoryItem = {
    ...target!,
    id: `evt-${i}`,
    type: 'event',
    content: { kind: 'event', key: `event.e2e.${i}`, value: `${topics[i]}安排`, source: 'user_said' },
    sourceSpan: `明天记得${topics[i]}`,
    createdAt: target!.createdAt + (i + 1) * 60_000,
    status: 'committed',
  };
  storage.insertMemoryItem(item);
}

// 3) 对照：旧"最近高置信 8 条"逻辑必不含目标（同置信下按时间排，目标在 13 名开外）
const oldStyle = storage.listHotMemories(ownerId, 8).filter((item) => item.type !== 'preference');
assert.ok(!oldStyle.some((item) => item.id === target!.id), '【对照】旧逻辑注入窗必不含目标记忆');

// 4) 新逻辑：recall 必召回
const result = await memory.recall({ ownerId, query: '我对什么过敏来着', limit: 8 });
assert.ok(
  result.memories.some((item) => item.id === target!.id),
  `【核心】新 recall 必含目标记忆，实际注入: ${result.memories.map((m) => m.content.key).join(',')}`,
);
assert.ok(result.matchedKeywords?.includes('过敏'), `matchedKeywords 应含"过敏"，实际: ${result.matchedKeywords}`);
assert.ok((result.relevantCount ?? 0) >= 1, 'relevantCount ≥1');
assert.ok(result.memories.length <= 8, '不超 limit');
assert.ok(result.elapsedMs < 200, `recall 应 <200ms，实际 ${result.elapsedMs.toFixed(1)}ms`);

// 5) recency 保底：最新的闲聊 event 也应在注入里（防"刚说的事"漏掉）
assert.ok(
  result.memories.some((item) => item.id === 'evt-11'),
  'recency 保底应带上最新记忆',
);

// 6) 退化契约：纯语气 query → 与旧逻辑完全一致
const degraded = await memory.recall({ ownerId, query: '嗯嗯好的吧', limit: 8 });
assert.equal(degraded.matchedKeywords, undefined, '退化时无 matchedKeywords');
assert.deepEqual(
  degraded.memories.map((item) => item.id),
  (() => {
    const pref = storage.listPrefSummaries(ownerId);
    const hot = storage.listHotMemories(ownerId, 8).filter((item) => item.type !== 'preference');
    return [...pref.map(() => 'pref'), ...hot.map((item) => item.id)].slice(0, 8).filter((id) => id !== 'pref');
  })(),
  '退化路径与旧逻辑注入完全一致',
);

// 7) 无身份：行为不变（identity_unstable 降级）
const noOwner = await memory.recall({ ownerId: undefined, query: '我对什么过敏', limit: 8 });
assert.equal(noOwner.degradationReason, 'identity_unstable');
assert.equal(noOwner.memories.length, 0);

storage.close();
console.log('✅ recall-integration.test ok（旧逻辑必挂 → 新逻辑必过 对照成立）');
