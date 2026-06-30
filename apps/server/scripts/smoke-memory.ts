import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import { TurnTrace, writeTelemetry } from '../src/telemetry.js';

const dir = mkdtempSync(join(tmpdir(), 'myjavis-smoke-'));
const storage = new SQLiteMemoryStorage(join(dir, 'memory.db'));
const identity = new VolcIdentityProvider(storage);
const eventLog = new EventLog(storage);
const memory = new MyJavisMemory(storage, eventLog);

const resolved = identity.resolve({ roomId: 'room-smoke', voiceprintId: 'vp_chuan', voiceprintName: '川哥', score: 0.91 });
const trace = new TurnTrace({ roomId: 'room-smoke', turnId: 'turn-smoke', identity: resolved });
const result = await memory.remember({
  roomId: 'room-smoke',
  ownerId: resolved.ownerId,
  identity: resolved,
  utterance: '记住我喜欢冰美式',
  sourceRole: 'user',
  isFinal: true,
  asrConfidence: 0.98,
});
const recalled = await trace.measure('memoryReadMs', () =>
  memory.recall({ ownerId: resolved.ownerId, query: '我喜欢喝什么', limit: 5 }),
);
trace.addMemoryUse({
  readMemoryIds: recalled.readMemoryIds,
  injectedMemoryIds: recalled.injectedMemoryIds,
  usedProvisional: recalled.usedProvisional,
});
const telemetryPath = join(dir, 'telemetry.ndjson');
writeTelemetry(trace.finish(), telemetryPath);

assert.equal(result.status, 'stored');
assert.equal(storage.count('event_log'), 1);
assert.equal(storage.count('memory_item'), 1);
assert.equal(recalled.memories.length, 1);
assert.ok(readFileSync(telemetryPath, 'utf8').includes('turn-smoke'));

storage.close();
console.log('smoke-memory ok');
