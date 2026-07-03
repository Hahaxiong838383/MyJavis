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

// ---------- 对话式注册：意图识别 + 会话状态机 ----------
{
  const {
    detectEnrollIntent,
    startEnroll,
    getEnroll,
    completeEnroll,
    failEnroll,
    clearEnroll,
    MAX_ATTEMPTS,
  } = await import('../src/voiceprint/enroll-session.js');

  // 应命中
  assert.equal(detectEnrollIntent('我是川哥，记住我')?.displayName, '川哥');
  assert.equal(detectEnrollIntent('Javis，我是小明，记住我')?.displayName, '小明');
  assert.equal(detectEnrollIntent('我叫Alice，请记住我')?.displayName, 'Alice');
  assert.equal(detectEnrollIntent('我是老王记住我')?.displayName, '老王');
  assert.equal(detectEnrollIntent('我是阿珍，认识一下我吧')?.displayName, '阿珍');
  assert.equal(detectEnrollIntent('我是大熊，记住我的声音')?.displayName, '大熊');
  assert.equal(detectEnrollIntent('你好呀，我是川哥，记一下我')?.displayName, '川哥');

  // 不应命中（误触发防御）
  assert.equal(detectEnrollIntent('我是不是让你记住我的日程了'), null);
  assert.equal(detectEnrollIntent('帮我记住明天开会'), null);
  assert.equal(detectEnrollIntent('我是谁你记住我干嘛'), null);
  assert.equal(detectEnrollIntent('今天天气不错'), null);
  assert.equal(detectEnrollIntent('我是昨天跟你说过记住我日程的那个人'), null); // 名字位>8字

  // 会话状态机
  const room = 'room-enroll-test';
  startEnroll(room, '川哥');
  assert.equal(getEnroll(room)?.state, 'recording');
  startEnroll(room, '川哥本人'); // Prefill interim→final 幂等覆盖名字
  assert.equal(getEnroll(room)?.displayName, '川哥本人');

  // 失败重试：MAX_ATTEMPTS 前回 recording，之后 failed
  for (let i = 1; i < MAX_ATTEMPTS; i++) assert.equal(failEnroll(room, 'too short'), true);
  assert.equal(getEnroll(room)?.state, 'recording');
  assert.equal(failEnroll(room, 'too short again'), false);
  assert.equal(getEnroll(room)?.state, 'failed');

  clearEnroll(room);
  startEnroll(room, '川哥');
  completeEnroll(room);
  assert.equal(getEnroll(room)?.state, 'done');
  clearEnroll(room);
  assert.equal(getEnroll(room), undefined);
}

console.log('enroll-session.test ✅ 全部通过');

// ---------- 识别链路：标签解析 + identity active 映射 ----------
{
  const { parseSpeakerTag, stripSpeakerTag, resolveSpeakerFromTag } = await import(
    '../src/voiceprint/speaker-tag.js'
  );
  const { normalizeSpeakerEvidence } = await import('../src/memory/identity/index.js');
  const { saveVoiceprint, newAudioName } = registry;

  // 官方示例形态（半角括号，句尾）
  let r = parseSpeakerTag('今天天气怎么样(当前说话人是jv_ab12cd34)');
  assert.equal(r.cleanText, '今天天气怎么样');
  assert.equal(r.audioName, 'jv_ab12cd34');
  // 全角括号 + 句首
  r = parseSpeakerTag('（当前说话人是jv_ab12cd34）今天天气怎么样');
  assert.equal(r.cleanText, '今天天气怎么样');
  assert.equal(r.audioName, 'jv_ab12cd34');
  // 带冒号变体 + 空格
  r = parseSpeakerTag('( 当前说话人是: jv_x )你好');
  assert.equal(r.audioName, 'jv_x');
  // 多个标签全剥，取第一个
  r = parseSpeakerTag('(当前说话人是jv_a)你好(当前说话人是jv_b)');
  assert.equal(r.cleanText, '你好');
  assert.equal(r.audioName, 'jv_a');
  // 无标签原样
  r = parseSpeakerTag('普通一句话（笑）');
  assert.equal(r.cleanText, '普通一句话（笑）');
  assert.equal(r.audioName, undefined);
  assert.equal(stripSpeakerTag('(当前说话人是jv_z)嗯嗯'), '嗯嗯');

  // registry 反查 → payload → identity 定级
  const an = newAudioName();
  saveVoiceprint({ voiceprintId: 'vp_tag_test', audioName: an, displayName: '川哥' });
  const resolved = resolveSpeakerFromTag(an, 'room-x');
  assert.equal(resolved.record?.displayName, '川哥');
  assert.equal(resolved.payload.status, 'active');
  const ev = normalizeSpeakerEvidence(resolved.payload);
  assert.equal(ev.state, 'active_stable'); // 标签在场 = 过了火山 Score 阈值 → 稳定态（无实时分）
  assert.ok(ev.confidence >= 0.9);

  // registry 查不到 → unverified（记忆走 quarantine，不串账）
  const unmatched = resolveSpeakerFromTag('jv_ghost', 'room-x');
  assert.equal(unmatched.record, undefined);
  assert.equal(normalizeSpeakerEvidence(unmatched.payload).state, 'unverified');
}

console.log('speaker-tag.test ✅ 全部通过');
