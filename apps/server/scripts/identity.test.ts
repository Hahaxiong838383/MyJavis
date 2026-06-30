import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';

const dbPath = join(mkdtempSync(join(tmpdir(), 'myjavis-identity-')), 'memory.db');
const storage = new SQLiteMemoryStorage(dbPath);
const identity = new VolcIdentityProvider(storage);

assert.equal(identity.resolve({ roomId: 'r1' }).state, 'unverified');
assert.equal(identity.resolve({ roomId: 'r1', voiceprintId: 'vp1', score: 0.2 }).state, 'registering');
assert.equal(identity.resolve({ roomId: 'r1', voiceprintId: 'vp1', score: 0.55 }).state, 'active_low');
const stable = identity.resolve({ roomId: 'r1', voiceprintId: 'vp1', voiceprintName: '川哥', score: 0.9 });
assert.equal(stable.state, 'active_stable');
assert.ok(stable.ownerId);
assert.equal(stable.quarantine, false);
assert.equal(identity.resolve({ roomId: 'r1', voiceprintId: 'vp1', score: 0.9, status: 'revoked' }).state, 'revoked');
assert.equal(storage.count('speaker_evidence'), 5);

storage.close();
console.log('identity.test ok');
