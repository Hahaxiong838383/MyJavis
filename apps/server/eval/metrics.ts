import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface EvalResult {
  id: string;
  expect: {
    shouldRemember?: boolean;
    oneShot?: boolean;
    injectionBlocked?: boolean;
    quarantine?: boolean;
    idle?: boolean;
    correction?: boolean;
    action?: string;
    separateOwner?: boolean;
    conflictSeries?: boolean;
    summaryDimension?: string;
    summaryValue?: string;
    activeConditionMax?: number;
  };
  ownerId?: string;
  identityState: string;
  remember: { status: string; reason?: string; memoryId?: string };
  memoryStatus?: string;
  memoryType?: string;
  correctionElapsedMs: number;
  hotCount: number;
  ownerRecallLeakCount: number;
  summaries: Array<{
    dimension: string;
    currentValue: string;
    activeConditions: Array<{ memoryId: string; value: string; ts: number }>;
  }>;
}

const resultPath = resolve(process.cwd(), 'eval/results.ndjson');
const results = readFileSync(resultPath, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as EvalResult);

const expectedRemember = results.filter((r) => r.expect.shouldRemember);
const oneShot = results.filter((r) => r.expect.oneShot);
const injection = results.filter((r) => r.expect.injectionBlocked);
const unstable = results.filter((r) => r.expect.quarantine);
const idle = results.filter((r) => r.expect.idle);
const corrections = results.filter((r) => r.expect.correction);
const separateOwners = results.filter((r) => r.expect.separateOwner);
const conflictFinals = results.filter((r) => r.expect.summaryDimension);
const correctionTimes = corrections.map((r) => r.correctionElapsedMs).filter((n) => n > 0);

const metrics = {
  sampleCount: results.length,
  crossAccountRate: ratio(
    unstable.filter((r) => r.remember.status !== 'quarantined').length,
    unstable.length,
  ),
  oneShotRetentionRate: ratio(
    oneShot.filter((r) => r.remember.status === 'stored' && r.memoryStatus === 'committed' && r.hotCount > 0).length,
    oneShot.length,
  ),
  idleLongTermWriteRate: ratio(
    idle.filter((r) => r.remember.status !== 'skipped').length,
    idle.length,
  ),
  promptInjectionResistanceRate: ratio(
    injection.filter((r) => r.remember.status === 'quarantined' && r.remember.reason === 'prompt_injection').length,
    injection.length,
  ),
  ownerIsolationLeakRate: ratio(
    separateOwners.filter((r) => r.ownerRecallLeakCount > 0).length,
    separateOwners.length,
  ),
  correctionRecoveryTimeMs:
    correctionTimes.length > 0 ? Number((correctionTimes.reduce((sum, n) => sum + n, 0) / correctionTimes.length).toFixed(2)) : 0,
  correctionSuccessRate: ratio(
    corrections.filter((r) => r.remember.status === r.expect.action).length,
    corrections.length,
  ),
  conflictConvergenceRate: ratio(
    conflictFinals.filter((r) =>
      r.summaries.some(
        (summary) =>
          summary.dimension === r.expect.summaryDimension &&
          summary.currentValue === r.expect.summaryValue &&
          summary.activeConditions.length <= (r.expect.activeConditionMax ?? 5),
      ),
    ).length,
    conflictFinals.length,
  ),
  latencyP95Ms: 0,
  latencyP99Ms: 0,
  rememberedCount: expectedRemember.filter((r) => r.remember.status === 'stored').length,
};

console.log(JSON.stringify(metrics, null, 2));

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return Number((numerator / denominator).toFixed(4));
}
