import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';
import { MemoryRefiner } from '../src/memory/refine.js';
import { _resetActivity, listActivity, pushActivity } from '../src/activity/feed.js';
import type { LlmProvider } from '../src/providers/types.js';
import type { MemoryItem } from '../src/memory/types.js';

// R3 测试：bi-temporal 失效 + 批处理精修（mock LLM）+ 活动流。

const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-r3-')), 'memory.db'));
const memory = new MyJavisMemory(storage, new EventLog(storage));
const identity = new VolcIdentityProvider(storage);
const resolved = identity.resolve({ roomId: 'r3', voiceprintId: 'vp_r3', score: 0.95 });
const ownerId = resolved.ownerId!;

async function say(utterance: string): Promise<void> {
  await memory.remember({ roomId: 'r3', ownerId, tenantId: 'tn-r3', identity: resolved, utterance, sourceRole: 'user', isFinal: true });
}

// —— 1) bi-temporal：同 key 冲突（update 决策）→ 旧行 invalid 不删除，hot 不可见 ——
{
  _resetActivity();
  await say('记住我喜欢冰美式');
  await say('记住我喜欢喝拿铁'); // 同 preference.drink 维度 → update 决策
  const all = storage.listOwnerMemories(ownerId, 50).filter((item) => item.content.key === 'preference.drink');
  assert.ok(all.length >= 2, `新旧两行都在库（历史可溯），实际 ${all.length}`);
  const hot = storage.listHotMemories(ownerId, 20).filter((item) => item.content.key === 'preference.drink');
  assert.equal(hot.length, 1, 'hot 视图只见最新事实');
  assert.ok(hot[0]!.content.value.includes('拿铁'), 'hot 里是新事实');
  // invalidate 活动事件已投递
  const acts = listActivity('tn-r3');
  assert.ok(acts.some((e) => e.kind === 'invalidate'), '失效事件进活动流');
  assert.ok(acts.some((e) => e.kind === 'write'), '写入事件进活动流');
}

// —— 2) recall 不会想起已失效事实 ——
{
  const result = await memory.recall({ ownerId, tenantId: 'tn-r3', query: '我喜欢喝什么咖啡', limit: 8 });
  const drinks = result.memories.filter((item) => item.content.key === 'preference.drink');
  assert.ok(drinks.every((item) => !item.content.value.includes('冰美式')), '已失效的旧偏好不进注入');
}

// —— 3) 精修器：mock LLM 的 INVALIDATE/MERGE/幻觉编号/坏输出四路 ——
{
  // 造两条同性质 event 重复 + 一条独立
  const base: MemoryItem = {
    id: 'dup-a', ownerId, namespace: `private:${ownerId}`, type: 'event',
    content: { kind: 'event', key: 'event.trip', value: '周三去深圳出差', source: 'user_said' },
    sourceRole: 'user', sourceSpan: '周三去深圳出差', confidence: 0.9, status: 'committed',
    createdAt: Date.now() - 1000, provenance: {}, acl: {},
  };
  storage.insertMemoryItem(base);
  storage.insertMemoryItem({ ...base, id: 'dup-b', content: { ...base.content, value: '这周三要去深圳出差一趟' }, createdAt: Date.now() - 500 });
  storage.insertMemoryItem({ ...base, id: 'solo', content: { kind: 'event', key: 'event.dinner', value: '周五家庭聚餐', source: 'user_said' }, createdAt: Date.now() - 300 });

  const mkLlm = (raw: string): LlmProvider => ({
    streamChat: async (args) => {
      args.onDone(raw);
    },
  });

  // 3a) MERGE 生效：dup-b 并入 dup-a（编号 1=dup? 顺序依赖 listRecallCandidates DESC——用编号探测法：
  // 直接给"全部 INVALIDATE 编号 99"（幻觉）+ 合法 MERGE 的混合，断言只有合法的生效
  _resetActivity();
  const refiner = new MemoryRefiner(
    storage,
    mkLlm('{"actions":[{"action":"INVALIDATE","target":99,"reason":"幻觉编号"},{"action":"MERGE","target":2,"keep":1,"value":"周三去深圳出差"}]}'),
    () => 'tn-r3',
  );
  const res = await refiner.refineOwner(ownerId);
  assert.ok(res, '应跑批');
  assert.equal(res!.applied, 1, `幻觉编号丢弃、合法 MERGE 生效，实际 applied=${res!.applied}`);
  const acts = listActivity('tn-r3');
  assert.ok(acts.some((e) => e.kind === 'refine'), '精修事件进活动流');

  // 3b) 坏输出容错：非 JSON → 零动作不抛
  const refiner2 = new MemoryRefiner(storage, mkLlm('抱歉我不能输出 JSON'), () => 'tn-r3');
  // 需要新记忆才会跑：再插两条
  storage.insertMemoryItem({ ...base, id: 'n1', content: { kind: 'event', key: 'event.x1', value: '取快递', source: 'user_said' }, createdAt: Date.now() });
  storage.insertMemoryItem({ ...base, id: 'n2', content: { kind: 'event', key: 'event.x2', value: '还书', source: 'user_said' }, createdAt: Date.now() });
  const res2 = await refiner2.refineOwner(ownerId);
  assert.ok(res2 && res2.applied === 0, '坏输出零动作不抛错');

  // 3c) 攒批阈值：无新记忆 → null 不调 LLM
  let calls = 0;
  const countingLlm: LlmProvider = {
    streamChat: async (args) => {
      calls += 1;
      args.onDone('{"actions":[]}');
    },
  };
  const refiner3 = new MemoryRefiner(storage, countingLlm, () => 'tn-r3');
  await refiner3.refineOwner(ownerId); // 第一次会跑（有历史新记忆）
  assert.equal(calls, 1);
  const res3 = await refiner3.refineOwner(ownerId); // 紧接第二次：无新增
  assert.equal(res3, null, '无新记忆不跑批');
  assert.equal(calls, 1, '第二次不调 LLM');
}

// —— 4) 活动流 ring buffer：cap 50 + 最新在前 ——
{
  _resetActivity();
  for (let i = 0; i < 55; i++) pushActivity('tn-ring', { kind: 'write', summary: `事件${i}` });
  const feed = listActivity('tn-ring');
  assert.equal(feed.length, 50, 'cap 50');
  assert.equal(feed[0]!.summary, '事件54', '最新在前');
  assert.equal(listActivity('tn-other').length, 0, '租户隔离');
}

storage.close();
console.log('✅ refine.test.ts 全部通过（bi-temporal 失效/精修四路/活动流）');
