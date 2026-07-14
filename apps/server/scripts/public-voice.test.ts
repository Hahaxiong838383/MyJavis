import assert from 'node:assert/strict';
import {
  activePublicVoicePolicyCount,
  clearPublicVoicePoliciesForTest,
  createPublicVoiceProof,
  getPublicVoicePolicy,
  registerPublicVoicePolicy,
  resolvePublicVoicePolicy,
} from '../src/public-voice/policy.js';
import { publicVoiceRoute } from '../src/routes/public-voice.js';
import { customLlmRoute } from '../src/routes/custom-llm.js';

async function main(): Promise<void> {
  process.env.PUBLIC_VOICE_SHARED_SECRET = 'test-public-secret';
  process.env.PUBLIC_VOICE_ENABLED = '1';

  const missing = await publicVoiceRoute.request('/status');
  assert.equal(missing.status, 401, '缺少共享密钥必须拒绝');

  const wrong = await publicVoiceRoute.request('/status', {
    headers: { 'x-public-voice-secret': 'wrong' },
  });
  assert.equal(wrong.status, 401, '错误共享密钥必须拒绝');

  const allowed = await publicVoiceRoute.request('/status', {
    headers: { 'x-public-voice-secret': 'test-public-secret' },
  });
  assert.equal(allowed.status, 200, '正确共享密钥应放行');

  clearPublicVoicePoliciesForTest();
  const policy = registerPublicVoicePolicy({
    roomId: 'public-mirror-test',
    systemPrompt: 'x'.repeat(100),
    promptVersion: 'test-v1',
    createdAt: 100,
    expiresAt: 200,
  });
  assert.deepEqual(policy.capabilities, {
    memory: false,
    voiceprint: false,
    reminders: false,
    music: false,
  });
  assert.equal(activePublicVoicePolicyCount(150), 1);
  assert.equal(activePublicVoicePolicyCount(250), 0);
  assert.equal(
    getPublicVoicePolicy('public-mirror-test')?.promptVersion,
    'test-v1',
    '到期策略需保留到 stop，隔离迟到回调',
  );
  clearPublicVoicePoliciesForTest();
  const proof = createPublicVoiceProof('public-mirror-restart');
  assert.equal(resolvePublicVoicePolicy('public-mirror-restart', 'wrong'), undefined);
  assert.equal(
    resolvePublicVoicePolicy('public-mirror-restart', proof)?.promptVersion,
    'restart-safe-fallback',
    '进程重启后，签名回调仍必须保持公开无记忆模式',
  );
  process.env.PUBLIC_VOICE_ONLY = '1';
  const privateCallback = await customLlmRoute.request('/chat/completions?session=not-public', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '不能进入私有链路' }] }),
  });
  assert.equal(privateCallback.status, 401, '独立站点服务必须拒绝无公开证明的 CustomLLM 回调');
  delete process.env.PUBLIC_VOICE_ONLY;
  console.log('public-voice.test: PASS');
}

void main();
