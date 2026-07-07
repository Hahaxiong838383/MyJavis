/**
 * e2e-recall-local.sh 的种子数据：往指定 DB 灌「目标 event 记忆 + 若干无关记忆」（safety 已走隐私路由不进云端库）。
 * 为什么预灌而非走 /v1 写入：remember 挂在 LLM 流 onDone 里，本地 E2E 无 LLM key
 * 时永不触发（生产不受影响）；写入闭环由 recall-integration.test.ts 真链路覆盖。
 * 用法：MYJAVIS_MEMORY_DB=<db> tsx scripts/e2e-seed-recall.ts <voiceprintId>
 */
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';
import type { MemoryItem } from '../src/memory/types.js';

const vp = process.argv[2];
if (!process.env.MYJAVIS_MEMORY_DB || !vp) {
  console.error('用法: MYJAVIS_MEMORY_DB=<db> tsx scripts/e2e-seed-recall.ts <voiceprintId>');
  process.exit(1);
}

const storage = new SQLiteMemoryStorage();
const memory = new MyJavisMemory(storage, new EventLog(storage));
const identity = new VolcIdentityProvider(storage);
const resolved = identity.resolve({ roomId: 'recall-room', voiceprintId: vp, score: 0.95 });
const ownerId = resolved.ownerId!;

// 目标记忆走真实 remember 链路
await memory.remember({
  roomId: 'recall-room',
  ownerId,
  identity: resolved,
  utterance: '我明天早上6点的航班',
  sourceRole: 'user',
  isFinal: true,
});
const target = storage.listOwnerMemories(ownerId, 20).find((item) => item.type === 'event');
if (!target) {
  console.error('seed 失败：event 记忆未落库');
  process.exit(1);
}

// 10 条时间在后的无关 event（把目标挤出"最近 8 条"，与集成测试同构）
const topics = ['图书馆还书', '快递取件', '球赛比分', '汇率牌价', '路况拥堵', '菜谱做法', '电影场次', '油价调整', '球鞋清洗', '空调维修'];
topics.forEach((topic, i) => {
  const item: MemoryItem = {
    ...target,
    id: `seed-evt-${i}`,
    type: 'event',
    content: { kind: 'event', key: `event.seed.${i}`, value: `${topic}安排`, source: 'user_said' },
    sourceSpan: `明天记得${topic}`,
    createdAt: target.createdAt + (i + 1) * 60_000,
    status: 'committed',
  };
  storage.insertMemoryItem(item);
});

storage.close();
console.log(`seeded owner=${ownerId} target=${target.id} +${topics.length} events`);
