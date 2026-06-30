import { createHash } from 'node:crypto';
import type { AdmissionDecision, MemoryCandidate, MemoryItem } from './types.js';

export function admitCandidate(args: {
  candidate: MemoryCandidate;
  existing: MemoryItem[];
  now?: number;
}): AdmissionDecision {
  const now = args.now ?? Date.now();
  const sameDimension = args.existing.filter((item) => item.content.key === args.candidate.dimension);
  const maxSimilarity = sameDimension.reduce(
    (max, item) => Math.max(max, similarity(item.content.value, args.candidate.content.value)),
    0,
  );
  const novelty = 1 - maxSimilarity;
  const conflicts = sameDimension
    .filter((item) => item.content.value !== args.candidate.content.value && item.status !== 'quarantine')
    .map((item) => item.id);

  if (args.candidate.salience < 0.35) {
    return {
      action: 'ignore',
      type: args.candidate.type,
      confidence: args.candidate.salience,
      conflicts,
      rationale: 'salience_below_threshold',
    };
  }

  if (maxSimilarity >= 0.9) {
    return {
      action: 'promote',
      type: args.candidate.type,
      confidence: Math.min(0.99, args.candidate.salience + 0.1),
      conflicts: [],
      rationale: `reinforced_existing novelty=${novelty.toFixed(2)} ts=${now}`,
      status: promoteStatus(args.candidate),
    };
  }

  const action = conflicts.length > 0 ? 'update' : 'store';
  const confidence = Math.min(0.99, args.candidate.salience * 0.75 + novelty * 0.2 + (conflicts.length ? 0.02 : 0.05));
  return {
    action,
    type: args.candidate.type,
    confidence,
    conflicts,
    rationale: `${action} salience=${args.candidate.salience.toFixed(2)} novelty=${novelty.toFixed(2)} conflicts=${conflicts.length}`,
    status: initialStatus(args.candidate),
  };
}

export function auditId(parts: string[]): string {
  return `aud_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`;
}

function initialStatus(candidate: MemoryCandidate): AdmissionDecision['status'] {
  switch (candidate.type) {
    case 'event':
    case 'safety':
      return 'committed';
    case 'profile_fact':
      return candidate.requiresConfirmation ? 'provisional' : 'committed';
    case 'preference':
    case 'reminder':
    case 'relationship':
    case 'location':
      return 'provisional';
    case 'ephemeral_context':
      return 'provisional';
  }
}

function promoteStatus(candidate: MemoryCandidate): AdmissionDecision['status'] {
  if (candidate.type === 'preference') return 'committed';
  return initialStatus(candidate);
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

function tokens(value: string): Set<string> {
  const compact = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const chars = Array.from(compact);
  if (chars.length <= 2) return new Set(chars);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(`${chars[i]}${chars[i + 1]}`);
  return grams;
}
