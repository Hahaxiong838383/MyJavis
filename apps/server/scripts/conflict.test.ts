import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';

const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-conflict-')), 'memory.db'));
const memory = new MyJavisMemory(storage, new EventLog(storage));
const identity = new VolcIdentityProvider(storage);
const resolved = identity.resolve({ roomId: 'conflict', voiceprintId: 'vp_conflict', score: 0.95 });
const ownerId = resolved.ownerId!;

for (const value of ['冰美式', '拿铁', '热茶', '咖啡', '茶饮料', '无糖咖啡', '冷萃咖啡']) {
  await memory.remember({
    roomId: 'conflict',
    ownerId,
    identity: resolved,
    utterance: `我喜欢${value}`,
    sourceRole: 'user',
    isFinal: true,
  });
}

const summaries = storage.listPrefSummaries(ownerId);
const drink = summaries.find((item) => item.dimension === 'preference.drink');
assert.equal(drink?.currentValue, '喜欢冷萃咖啡');
assert.equal(drink?.activeConditions.length, 5);

const recalled = await memory.recall({ ownerId, query: '我喜欢喝什么', limit: 10 });
assert.equal(recalled.memories.filter((item) => item.type === 'preference').length, 1);
assert.equal(recalled.memories.find((item) => item.type === 'preference')?.content.value, '喜欢冷萃咖啡');

storage.close();
console.log('conflict.test ok');
