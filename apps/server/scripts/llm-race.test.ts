/**
 * extraEndpoints 单测：赛马参赛路 env 解析（第 2 路 LLM_FALLBACK_* + 第 3 路 LLM_RACER3_*）。
 * 三件套配齐才入池、缺任一静默跳过；顺序 fallback 在前。
 * 跑法：npm run test:llm-race
 */
process.env.MYJAVIS_MEMORY_DB = ':memory:';

import assert from 'node:assert/strict';

const { extraEndpoints } = await import('../src/providers/llm.js');

const RACE_KEYS = [
  'LLM_FALLBACK_BASE_URL',
  'LLM_FALLBACK_API_KEY',
  'LLM_FALLBACK_MODEL',
  'LLM_RACER3_BASE_URL',
  'LLM_RACER3_API_KEY',
  'LLM_RACER3_MODEL',
] as const;

function resetEnv(): void {
  for (const k of RACE_KEYS) delete process.env[k];
}

// 1) 全不配 → 空池（单路 main）
resetEnv();
assert.deepEqual(extraEndpoints(), [], '无 env 应返回空数组');

// 2) 仅 fallback 三件套 → 1 路
resetEnv();
process.env.LLM_FALLBACK_BASE_URL = 'https://api.minimaxi.com/v1';
process.env.LLM_FALLBACK_API_KEY = 'k2';
process.env.LLM_FALLBACK_MODEL = 'MiniMax-M2.7-highspeed';
{
  const eps = extraEndpoints();
  assert.equal(eps.length, 1);
  assert.equal(eps[0]!.name, 'fallback:MiniMax-M2.7-highspeed');
}

// 3) fallback + racer3 全配 → 2 路，fallback 在前
process.env.LLM_RACER3_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
process.env.LLM_RACER3_API_KEY = 'k3';
process.env.LLM_RACER3_MODEL = 'doubao-seed-1-6-flash';
{
  const eps = extraEndpoints();
  assert.equal(eps.length, 2);
  assert.equal(eps[0]!.name, 'fallback:MiniMax-M2.7-highspeed');
  assert.equal(eps[1]!.name, 'racer3:doubao-seed-1-6-flash');
  assert.equal(eps[1]!.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
}

// 4) racer3 缺 API_KEY → 只剩 fallback（缺件静默跳过，不半配上场）
delete process.env.LLM_RACER3_API_KEY;
{
  const eps = extraEndpoints();
  assert.equal(eps.length, 1);
  assert.equal(eps[0]!.name, 'fallback:MiniMax-M2.7-highspeed');
}

resetEnv();
console.log('llm-race.test: all assertions passed ✓');
