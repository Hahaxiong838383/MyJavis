import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';

const storage = new SQLiteMemoryStorage(join(mkdtempSync(join(tmpdir(), 'myjavis-life-')), 'memory.db'));
const memory = new MyJavisMemory(storage, new EventLog(storage));
const identity = new VolcIdentityProvider(storage);
const resolved = identity.resolve({ roomId: 'life', voiceprintId: 'vp_life', score: 0.95 });
const ownerId = resolved.ownerId!;

await remember('我明天早上6点的航班');
await remember('我对青霉素过敏');
await remember('记住我喜欢冰美式');
await remember('记住今天阳光不错');

const items = storage.listOwnerMemories(ownerId, 20);
const event = items.find((item) => item.type === 'event');
const safety = items.find((item) => item.type === 'safety');
const preference = items.find((item) => item.type === 'preference');
const ephemeral = items.find((item) => item.type === 'ephemeral_context');

assert.equal(event?.status, 'committed');
assert.ok(event?.validUntil);
assert.equal(safety?.status, 'committed');
assert.equal(safety?.ttl, undefined);
assert.equal(preference?.status, 'provisional');
assert.equal(ephemeral?.status, 'provisional');
assert.ok(ephemeral?.ttl);
assert.equal(storage.countAudit('admission') >= 4, true);

storage.close();
console.log('lifecycle.test ok');

async function remember(utterance: string): Promise<void> {
  await memory.remember({
    roomId: 'life',
    ownerId,
    identity: resolved,
    utterance,
    sourceRole: 'user',
    isFinal: true,
  });
}
