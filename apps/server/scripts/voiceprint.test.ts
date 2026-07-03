/**
 * 声纹模块单测：WAV 头校验 + registry CRUD（registry 用 :memory: DB，不碰真实数据）。
 * 跑法：npm run test:voiceprint
 */
process.env.MYJAVIS_MEMORY_DB = ':memory:'; // 必须在 import registry（→ memory storage 单例）之前

import assert from 'node:assert/strict';
import { parseWavHeader, assertRegisterableWav } from '../src/voiceprint/wav.js';
const registry = await import('../src/voiceprint/registry.js');

// ---------- 合成 WAV ----------
function makeWav(opts: { sampleRate?: number; channels?: number; bits?: number; seconds?: number }): Buffer {
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const seconds = opts.seconds ?? 20;
  const dataBytes = Math.round(sampleRate * channels * (bits / 8) * seconds);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

// ---------- WAV 解析 ----------
{
  const info = parseWavHeader(makeWav({}));
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.ok(Math.abs(info.durationSec - 20) < 0.01, `duration=${info.durationSec}`);
}
assert.throws(() => parseWavHeader(Buffer.alloc(30)), /过短/);
assert.throws(() => parseWavHeader(Buffer.from('x'.repeat(64))), /RIFF/);

// 合法 20s 16k mono 16bit → 通过
assertRegisterableWav(makeWav({}).toString('base64'));
// 8kHz → 拒
assert.throws(() => assertRegisterableWav(makeWav({ sampleRate: 8000 }).toString('base64')), /16kHz/);
// 双声道 → 拒
assert.throws(() => assertRegisterableWav(makeWav({ channels: 2 }).toString('base64')), /单声道/);
// 10s 太短 → 拒
assert.throws(() => assertRegisterableWav(makeWav({ seconds: 10 }).toString('base64')), /15~30s/);
// 35s 太长 → 拒
assert.throws(() => assertRegisterableWav(makeWav({ seconds: 35 }).toString('base64')), /15~30s/);
// 8bit → 拒
assert.throws(() => assertRegisterableWav(makeWav({ bits: 8 }).toString('base64')), /16bit/);

// ---------- registry ----------
{
  const { saveVoiceprint, listActiveVoiceprints, findByDisplayName, findByAudioName, removeVoiceprint, newAudioName } =
    registry;

  const name1 = newAudioName();
  assert.match(name1, /^jv_[0-9a-f]{8}$/);

  const rec = saveVoiceprint({ voiceprintId: 'vp_test_001', audioName: name1, displayName: '川哥' });
  assert.equal(rec.displayName, '川哥');
  assert.match(rec.ownerId, /^owner_[0-9a-f]{16}$/); // 与 identity 层同派生

  saveVoiceprint({ voiceprintId: 'vp_test_002', audioName: newAudioName(), displayName: '嫂子' });
  assert.equal(listActiveVoiceprints().length, 2);
  assert.equal(findByDisplayName('川哥')?.voiceprintId, 'vp_test_001');
  assert.equal(findByAudioName(name1)?.displayName, '川哥');

  // upsert：同 voiceprintId 重存 = 更新
  saveVoiceprint({ voiceprintId: 'vp_test_001', audioName: name1, displayName: '川哥v2' });
  assert.equal(listActiveVoiceprints().length, 2);
  assert.equal(findByDisplayName('川哥v2')?.voiceprintId, 'vp_test_001');

  assert.equal(removeVoiceprint('vp_test_001'), true);
  assert.equal(removeVoiceprint('vp_test_001'), false); // 已删
  assert.equal(listActiveVoiceprints().length, 1);
}

console.log('voiceprint.test ✅ 全部通过');
