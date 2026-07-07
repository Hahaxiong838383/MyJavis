import assert from 'node:assert/strict';
import {
  enrollConfirmNameLine,
  enrollFullLine,
  extractNameReply,
  extractNameReplyDetailed,
  isConfirmNo,
  isConfirmYes,
  startEnrollAwaitingName,
  startEnrollConfirmingName,
  backToAwaitingName,
  getEnroll,
  clearEnroll,
} from '../src/voiceprint/enroll-session.js';
import { detectForgetIntent } from '../src/voiceprint/forget-session.js';

// —— S1：裸名字 vs 带前缀（真机"唱歌"误注册事故防线） ——
let r = extractNameReplyDetailed('我叫川哥');
assert.equal(r?.name, '川哥');
assert.equal(r?.bare, false, '带前缀不算裸名');
r = extractNameReplyDetailed('川哥');
assert.equal(r?.name, '川哥');
assert.equal(r?.bare, true, '裸名字须确认');
r = extractNameReplyDetailed('唱歌'); // 事故原型：闲聊词形态上就是裸名 → 靠确认环节拦
assert.equal(r?.bare, true);
assert.equal(extractNameReplyDetailed('哈哈随便啦'), null, '口头禅黑名单');
assert.equal(extractNameReplyDetailed('就不说'), null, '含否定字拒');
assert.equal(extractNameReply('我叫川哥'), '川哥', '旧签名兼容');

// —— S1：确认/否认词 ——
assert.ok(isConfirmYes('对'));
assert.ok(isConfirmYes('对的'));
assert.ok(isConfirmYes('没错。'));
assert.ok(isConfirmYes('嗯嗯'));
assert.ok(isConfirmYes('确定啊'));
assert.ok(!isConfirmYes('对不对'), '疑问不算确认');
assert.ok(!isConfirmYes('好像是吧'), '含糊不算确认');
assert.ok(isConfirmNo('不对'));
assert.ok(isConfirmNo('不是，我叫川哥'));
assert.ok(!isConfirmNo('对'));

// —— S1：状态机流转 ——
const room = 's1-room';
startEnrollAwaitingName(room);
assert.equal(getEnroll(room)?.state, 'awaiting_name');
startEnrollConfirmingName(room, '唱歌');
assert.equal(getEnroll(room)?.state, 'confirming_name');
assert.equal(getEnroll(room)?.displayName, '唱歌');
backToAwaitingName(room);
assert.equal(getEnroll(room)?.state, 'awaiting_name');
assert.equal(getEnroll(room)?.displayName, '');
clearEnroll(room);
assert.equal(getEnroll(room), undefined);
assert.ok(enrollConfirmNameLine('川哥').includes('川哥'));

// —— S2：忘掉声纹意图（宁漏勿误） ——
let f = detectForgetIntent('忘掉川哥的声音');
assert.equal(f?.target, '川哥');
f = detectForgetIntent('删除陆总的声纹吧');
assert.equal(f?.target, '陆总');
f = detectForgetIntent('忘掉我的声音');
assert.equal(f?.target, 'SELF');
assert.equal(detectForgetIntent('我忘掉钥匙了'), null, '叙述不命中');
assert.equal(detectForgetIntent('把声音调大一点'), null);
assert.equal(detectForgetIntent('忘掉那件事吧'), null, '非声纹域不命中');

// —— S3：满员话术给出语音删除路径 ——
const full = enrollFullLine(['川哥', '陆总', '小美']);
assert.ok(full.includes('忘掉某某的声音'), '满员话术联动 S2');
assert.ok(full.includes('川哥、陆总、小美'));

console.log('voiceprint-s123.test ok');
