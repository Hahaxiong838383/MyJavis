import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { IdentityResolution } from './memory/types.js';

export interface MemoryUseTrace {
  turnId: string;
  roomId: string;
  ts: number;
  speakerEvidence?: {
    id: string;
    state: string;
    voiceprintId?: string;
    score?: number;
    ownerId?: string;
    quarantine: boolean;
    reason?: string;
  };
  readMemoryIds: string[];
  injectedMemoryIds: string[];
  degradationReasons: string[];
  usedProvisional: boolean;
}

export interface LatencyTrace {
  networkRttMs?: number;
  memoryReadMs?: number;
  promptAssemblyMs?: number;
  llmTtftMs?: number;
  totalMs?: number;
}

export interface TurnTelemetry {
  kind: 'turn';
  memoryUse: MemoryUseTrace;
  latency: LatencyTrace;
}

const DEFAULT_TELEMETRY_PATH = resolve(process.cwd(), 'data/telemetry/turns.ndjson');

export class TurnTrace {
  private readonly startedAt = performance.now();
  readonly memoryUse: MemoryUseTrace;
  readonly latency: LatencyTrace = {};

  constructor(args: { roomId: string; turnId: string; identity?: IdentityResolution; networkRttMs?: number }) {
    this.memoryUse = {
      turnId: args.turnId,
      roomId: args.roomId,
      ts: Date.now(),
      speakerEvidence: args.identity
        ? {
            id: args.identity.evidence.id,
            state: args.identity.state,
            voiceprintId: args.identity.evidence.voiceprintId,
            score: args.identity.evidence.score,
            ownerId: args.identity.ownerId,
            quarantine: args.identity.quarantine,
            reason: args.identity.reason,
          }
        : undefined,
      readMemoryIds: [],
      injectedMemoryIds: [],
      degradationReasons: [],
      usedProvisional: false,
    };
    this.latency.networkRttMs = args.networkRttMs;
  }

  async measure<T>(name: 'memoryReadMs' | 'promptAssemblyMs', fn: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.latency[name] = performance.now() - start;
    }
  }

  markLlmFirstToken(): void {
    if (this.latency.llmTtftMs === undefined) {
      this.latency.llmTtftMs = performance.now() - this.startedAt;
    }
  }

  addMemoryUse(args: {
    readMemoryIds?: string[];
    injectedMemoryIds?: string[];
    degradationReason?: string;
    usedProvisional?: boolean;
  }): void {
    if (args.readMemoryIds) this.memoryUse.readMemoryIds.push(...args.readMemoryIds);
    if (args.injectedMemoryIds) this.memoryUse.injectedMemoryIds.push(...args.injectedMemoryIds);
    if (args.degradationReason) this.memoryUse.degradationReasons.push(args.degradationReason);
    if (args.usedProvisional) this.memoryUse.usedProvisional = true;
  }

  finish(): TurnTelemetry {
    this.latency.totalMs = performance.now() - this.startedAt;
    return { kind: 'turn', memoryUse: this.memoryUse, latency: this.latency };
  }
}

export function writeTelemetry(record: TurnTelemetry, filePath = process.env.MYJAVIS_TELEMETRY_PATH ?? DEFAULT_TELEMETRY_PATH): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function networkRttFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get('x-request-start') ?? headers.get('x-volc-request-start');
  if (!raw) return undefined;
  const parsed = Number(raw.replace(/^t=/, ''));
  if (!Number.isFinite(parsed)) return undefined;
  const startMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  return Math.max(0, Date.now() - startMs);
}
