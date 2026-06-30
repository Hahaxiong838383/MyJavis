import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface EvalResult {
  id: string;
  expect: {
    shouldRemember?: boolean;
    oneShot?: boolean;
    injectionBlocked?: boolean;
    quarantine?: boolean;
  };
  ownerId?: string;
  identityState: string;
  remember: { status: string; reason?: string };
  hotCount: number;
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

const metrics = {
  sampleCount: results.length,
  crossAccountRate: ratio(
    unstable.filter((r) => r.remember.status !== 'quarantined').length,
    unstable.length,
  ),
  oneShotRetentionRate: ratio(
    oneShot.filter((r) => r.remember.status === 'stored' && r.hotCount > 0).length,
    oneShot.length,
  ),
  promptInjectionResistanceRate: ratio(
    injection.filter((r) => r.remember.status === 'quarantined' && r.remember.reason === 'prompt_injection').length,
    injection.length,
  ),
  correctionRecoveryTimeMs: 0,
  latencyP95Ms: 0,
  latencyP99Ms: 0,
  rememberedCount: expectedRemember.filter((r) => r.remember.status === 'stored').length,
};

console.log(JSON.stringify(metrics, null, 2));

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return Number((numerator / denominator).toFixed(4));
}
