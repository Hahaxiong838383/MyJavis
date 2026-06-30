import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';

const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-governance-')), 'memory.db'));
const memory = new MyJavisMemory(storage, new EventLog(storage));
const identity = new VolcIdentityProvider(storage);
const ownerA = identity.resolve({ roomId: 'governance', voiceprintId: 'vp_governance_a', score: 0.95 });
const ownerB = identity.resolve({ roomId: 'governance', voiceprintId: 'vp_governance_b', score: 0.95 });

const eventA = await remember(ownerA, '我明天早上6点的航班');
assert.ok(eventA.memoryId);
const eventB = await remember(ownerB, '我明天晚上9点的航班');
assert.ok(eventB.memoryId);

const beforeSuspend = await memory.recall({ ownerId: ownerA.ownerId, query: '航班', limit: 10 });
assert.ok(beforeSuspend.memories.some((item) => item.id === eventA.memoryId));

const suspended = await memory.suspend(ownerA.ownerId!, eventA.memoryId!);
assert.equal(suspended.ok, true);
assert.equal(storage.getMemoryItem(eventA.memoryId!)?.suspended, true);

const afterSuspend = await memory.recall({ ownerId: ownerA.ownerId, query: '航班', limit: 10 });
assert.equal(afterSuspend.memories.some((item) => item.id === eventA.memoryId), false);

const resumed = await memory.resume(ownerA.ownerId!, eventA.memoryId!);
assert.equal(resumed.ok, true);
const afterResume = await memory.recall({ ownerId: ownerA.ownerId, query: '航班', limit: 10 });
assert.ok(afterResume.memories.some((item) => item.id === eventA.memoryId));

const exportedA = await memory.exportOwner(ownerA.ownerId!);
assert.ok(exportedA.memories.some((item) => item.id === eventA.memoryId));
assert.equal(exportedA.memories.some((item) => item.id === eventB.memoryId), false);
assert.ok(exportedA.memories.every((item) => item.ownerId === ownerA.ownerId));

const crossSuspend = await memory.suspend(ownerB.ownerId!, eventA.memoryId!);
assert.equal(crossSuspend.ok, false);
assert.equal(crossSuspend.reason, 'cross_owner_rejected');
assert.equal(storage.getMemoryItem(eventA.memoryId!)?.suspended, false);

const crossDelete = await memory.delete(ownerB.ownerId!, eventA.memoryId!);
assert.equal(crossDelete.ok, false);
assert.equal(crossDelete.reason, 'cross_owner_rejected');
assert.ok(storage.getMemoryItem(eventA.memoryId!));

const deleted = await memory.delete(ownerA.ownerId!, eventA.memoryId!);
assert.equal(deleted.ok, true);
assert.equal(storage.getMemoryItem(eventA.memoryId!), undefined);
assert.ok(storage.countAudit('governance') >= 5);

storage.close();
console.log('governance.test ok');

async function remember(
  resolved: typeof ownerA,
  utterance: string,
): Promise<Awaited<ReturnType<MyJavisMemory['remember']>>> {
  return memory.remember({
    roomId: 'governance',
    ownerId: resolved.ownerId,
    identity: resolved,
    utterance,
    sourceRole: 'user',
    isFinal: true,
  });
}
