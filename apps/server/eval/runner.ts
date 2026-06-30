import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SQLiteMemoryStorage } from '../src/memory/storage.js';
import { EventLog } from '../src/session/event-log.js';
import { MyJavisMemory } from '../src/memory/index.js';
import { VolcIdentityProvider } from '../src/memory/identity/index.js';
import type { SourceRole, VolcSpeakerPayload } from '../src/memory/types.js';

interface ReplaySample {
  id: string;
  speaker_evidence: VolcSpeakerPayload;
  utterance: string;
  sourceRole?: SourceRole;
  expect: Record<string, unknown>;
}

const inputPath = resolve(process.cwd(), 'eval/replay-samples.ndjson');
const outputPath = resolve(process.cwd(), 'eval/results.ndjson');
const storage = new SQLiteMemoryStorage(':memory:');
const identity = new VolcIdentityProvider(storage);
const memory = new MyJavisMemory(storage, new EventLog(storage));

const lines = readFileSync(inputPath, 'utf8').trim().split('\n').filter(Boolean);
const results = [];
for (const line of lines) {
  const sample = JSON.parse(line) as ReplaySample;
  const resolved = identity.resolve(sample.speaker_evidence);
  const remember = await memory.remember({
    roomId: sample.speaker_evidence.roomId ?? 'eval-room',
    ownerId: resolved.ownerId,
    identity: resolved,
    utterance: sample.utterance,
    sourceRole: sample.sourceRole ?? 'user',
    isFinal: true,
    asrConfidence: 0.95,
  });
  const recalled = await memory.recall({ ownerId: resolved.ownerId, query: sample.utterance, limit: 20 });
  results.push({
    id: sample.id,
    expect: sample.expect,
    ownerId: resolved.ownerId,
    identityState: resolved.state,
    remember,
    recalledIds: recalled.readMemoryIds,
    hotCount: recalled.memories.length,
    quarantinedCount: storage.listMemoriesByStatus('quarantine').length,
  });
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${results.map((result) => JSON.stringify(result)).join('\n')}\n`, 'utf8');
storage.close();
console.log(`phase0 replay wrote ${outputPath}`);
