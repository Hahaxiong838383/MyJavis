import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import type { MemoryItem, SpeakerEvidence } from '../src/memory/types.js';

const dbPath = join(mkdtempSync(join(tmpdir(), 'myjavis-storage-')), 'memory.db');
const storage = new SQLiteMemoryStorage(dbPath);
const now = Date.now();

const evidence: SpeakerEvidence = {
  id: 'sev_test',
  provider: 'volc',
  voiceprintId: 'vp_chuan',
  voiceprintName: '川哥',
  score: 0.92,
  mode: '2',
  rawPayload: { mock: true },
  roomId: 'room-test',
  ts: now,
  state: 'active_stable',
  confidence: 0.92,
};
storage.insertSpeakerEvidence(evidence);
storage.upsertOwner('owner_test', '川哥', 'active_stable', evidence.id);
assert.equal(storage.count('speaker_evidence'), 1);

const base: Omit<MemoryItem, 'id' | 'status'> = {
  ownerId: 'owner_test',
  namespace: 'private:owner_test',
  type: 'preference',
  content: { kind: 'preference', key: 'preference.drink', value: '喜欢冰美式', source: 'user_said' },
  sourceRole: 'user',
  sourceSpan: '记住我喜欢冰美式',
  confidence: 0.8,
  createdAt: now,
  provenance: { roomId: 'room-test' },
  acl: { read: ['owner_test'] },
  speakerEvidenceId: evidence.id,
};

storage.insertMemoryItem({ ...base, id: 'mem_committed', status: 'committed' });
storage.insertMemoryItem({ ...base, id: 'mem_provisional', status: 'provisional' });
storage.insertMemoryItem({ ...base, id: 'mem_quarantine', status: 'quarantine' });
storage.insertMemoryItem({ ...base, id: 'mem_committed', status: 'committed' });

assert.equal(storage.count('memory_item'), 3);
assert.deepEqual(
  storage
    .listHotMemories('owner_test', 10)
    .map((item) => item.id)
    .sort(),
  ['mem_committed', 'mem_provisional'],
);
assert.equal(storage.listMemoriesByStatus('quarantine')[0]?.id, 'mem_quarantine');

storage.close();
console.log('storage.test ok');
