import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';

const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-correction-')), 'memory.db'));
const memory = new MyJavisMemory(storage, new EventLog(storage));
const identity = new VolcIdentityProvider(storage);
const ownerA = identity.resolve({ roomId: 'correction', voiceprintId: 'vp_a', score: 0.95 });
const ownerB = identity.resolve({ roomId: 'correction', voiceprintId: 'vp_b', score: 0.95 });

const created = await memory.remember({
  roomId: 'correction',
  ownerId: ownerA.ownerId,
  identity: ownerA,
  utterance: '记住我喜欢冰美式',
  sourceRole: 'user',
  isFinal: true,
});
assert.ok(created.memoryId);

const deleted = await memory.remember({
  roomId: 'correction',
  ownerId: ownerA.ownerId,
  identity: ownerA,
  utterance: '忘掉这件事',
  sourceRole: 'user',
  isFinal: true,
  recentMemoryIds: [created.memoryId!],
});
assert.equal(deleted.status, 'deleted');
assert.equal(storage.getMemoryItem(created.memoryId!), undefined);

const reattrSource = await memory.remember({
  roomId: 'correction',
  ownerId: ownerA.ownerId,
  identity: ownerA,
  utterance: '记住我喜欢拿铁',
  sourceRole: 'user',
  isFinal: true,
});
const reattributed = await memory.remember({
  roomId: 'correction',
  ownerId: ownerA.ownerId,
  identity: ownerA,
  utterance: '那是别人说的',
  sourceRole: 'user',
  isFinal: true,
  recentMemoryIds: [reattrSource.memoryId!],
  targetOwnerId: ownerB.ownerId,
});
assert.equal(reattributed.status, 'reattributed');
assert.equal(storage.getMemoryItem(reattrSource.memoryId!)?.ownerId, ownerB.ownerId);

const rejected = await memory.remember({
  roomId: 'correction',
  ownerId: ownerA.ownerId,
  identity: ownerA,
  utterance: '忘掉这件事',
  sourceRole: 'user',
  isFinal: true,
  recentMemoryIds: [reattrSource.memoryId!],
});
assert.equal(rejected.reason, 'cross_owner_rejected');
assert.ok(storage.countAudit('correction') >= 3);

storage.close();
console.log('correction.test ok');
