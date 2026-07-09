import assert from 'node:assert/strict';
import { detectMusicIntent } from '../src/music/music-intent.js';
import { recordPlay, takePrevTrack, getMusicSession } from '../src/music/music-session.js';

// —— music-intent：query 提取修缮（2026-07-06 真机日志实锤三案） ——
// "听听"变体：曾捕获成"听周杰伦"搜出《英国老外听周杰伦》reaction 视频
let r = detectMusicIntent('我想听听周杰伦的歌');
assert.equal(r?.kind, 'play');
assert.equal((r as { query: string }).query, '周杰伦');
// 裸"的"收尾（判停截断）：曾搜"周杰伦的"冲顶《周杰伦的床边故事》
r = detectMusicIntent('我想听周杰伦的');
assert.equal(r?.kind, 'play');
assert.equal((r as { query: string }).query, '周杰伦');
// interim 截断"播放一"：query 只剩"一"→ 反问而不是搜"一"
r = detectMusicIntent('播放一');
assert.equal(r?.kind, 'play_generic');
// 回归：夜曲 query 不被啃、头部量词剥离仍工作
r = detectMusicIntent('播放一首夜曲');
assert.equal((r as { query: string }).query, '夜曲');
r = detectMusicIntent('放一首一路向北');
assert.equal((r as { query: string }).query, '一路向北');
// 控制词回归
assert.equal(detectMusicIntent('上一首')?.kind, 'control');
assert.equal((detectMusicIntent('上一首') as { action: string }).action, 'prev');
assert.equal((detectMusicIntent('换一首吧') as { action: string }).action, 'next');
assert.equal((detectMusicIntent('停止播放') as { action: string }).action, 'pause');

// —— 闲聊撞词反例（2026-07-08 川哥真机："我们换一个话题"被回"还没放歌"） ——
// 无音乐锚定的"换一个/换一换/上一个"已从正则剔除；有锚定的指令不受影响。
assert.equal(detectMusicIntent('我们换一个话题'), null, '换话题是闲聊不是切歌');
assert.equal(detectMusicIntent('换一个说法呢'), null, '换说法不是切歌');
assert.equal(detectMusicIntent('上一个问题你还没回答'), null, '上一个问题不是上一曲');
assert.equal((detectMusicIntent('换一首') as { action: string }).action, 'next', '带歌曲锚定仍是切歌');
assert.equal((detectMusicIntent('切歌') as { action: string }).action, 'next');
assert.equal((detectMusicIntent('上一曲') as { action: string }).action, 'prev');

// —— music-session：播放历史栈（真"上一首"） ——
const room = 'test-prev-room';
const T = (n: number) => ({ id: `id${n}`, source: 'bilibili', title: `歌${n}` });
recordPlay(room, '周杰伦', T(1));
recordPlay(room, '周杰伦', T(2));
recordPlay(room, '周杰伦', T(3));
// 栈 [1,2,3]，上一首 → 弹3、弹出并返回2
let prev = takePrevTrack(room);
assert.equal(prev?.id, 'id2');
// 播放"歌2"会重新入栈 → 栈 [1,2]
recordPlay(room, '周杰伦', T(2));
assert.equal(getMusicSession(room)?.playedTracks.length, 2);
// 再上一首 → 返回1
prev = takePrevTrack(room);
assert.equal(prev?.id, 'id1');
recordPlay(room, '周杰伦', T(1));
// 栈只剩 [1]：没有上一首了
assert.equal(takePrevTrack(room), null);
// 连播同曲不重复入栈
recordPlay(room, '周杰伦', T(1));
assert.equal(getMusicSession(room)?.playedTracks.length, 1);

console.log('music.test ok');
