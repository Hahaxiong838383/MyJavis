import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
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
  recentMemoryFrom?: string;
  targetOwnerFrom?: string;
  expect: Record<string, unknown>;
}

const inputPath = resolve(process.cwd(), 'eval/replay-samples.ndjson');
const outputPath = resolve(process.cwd(), 'eval/results.ndjson');
const storage = new SQLiteMemoryStorage(':memory:');
const identity = new VolcIdentityProvider(storage);
const memory = new MyJavisMemory(storage, new EventLog(storage));

const lines = readFileSync(inputPath, 'utf8').trim().split('\n').filter(Boolean);
const results = [];
const memoryIdBySample = new Map<string, string>();
const ownerIdByVoiceprint = new Map<string, string>();
for (const line of lines) {
  const sample = JSON.parse(line) as ReplaySample;
  const resolved = identity.resolve(sample.speaker_evidence);
  if (sample.speaker_evidence.voiceprintId && resolved.ownerId) {
    ownerIdByVoiceprint.set(sample.speaker_evidence.voiceprintId, resolved.ownerId);
  }
  const started = performance.now();
  const remember = await memory.remember({
    roomId: sample.speaker_evidence.roomId ?? 'eval-room',
    ownerId: resolved.ownerId,
    identity: resolved,
    utterance: sample.utterance,
    sourceRole: sample.sourceRole ?? 'user',
    isFinal: true,
    asrConfidence: 0.95,
    recentMemoryIds: sample.recentMemoryFrom ? [memoryIdBySample.get(sample.recentMemoryFrom) ?? 'missing'] : undefined,
    targetOwnerId: sample.targetOwnerFrom ? ownerIdByVoiceprint.get(sample.targetOwnerFrom) : undefined,
  });
  const elapsedMs = performance.now() - started;
  if (remember.memoryId) memoryIdBySample.set(sample.id, remember.memoryId);
  const recalled = await memory.recall({ ownerId: resolved.ownerId, query: sample.utterance, limit: 20 });
  const item = remember.memoryId ? storage.getMemoryItem(remember.memoryId) : undefined;
  const summaries = resolved.ownerId ? storage.listPrefSummaries(resolved.ownerId) : [];
  results.push({
    id: sample.id,
    expect: sample.expect,
    ownerId: resolved.ownerId,
    identityState: resolved.state,
    remember,
    memoryStatus: item?.status,
    memoryType: item?.type,
    correctionElapsedMs: (sample.expect.correction ? Math.max(1, elapsedMs) : 0),
    recalledIds: recalled.readMemoryIds,
    hotCount: recalled.memories.length,
    quarantinedCount: storage.listMemoriesByStatus('quarantine').length,
    summaries,
    ownerRecallLeakCount:
      sample.expect.separateOwner && resolved.ownerId
        ? recalled.memories.filter((memoryItem) => memoryItem.ownerId !== resolved.ownerId).length
        : 0,
  });
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${results.map((result) => JSON.stringify(result)).join('\n')}\n`, 'utf8');
storage.close();
console.log(`phase0 replay wrote ${outputPath}`);
