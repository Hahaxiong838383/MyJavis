/**
 * 音乐意图检测（严格版，宁漏勿误）。
 *
 * 参照 enroll-session.ts 的设计教训：过泛正则会把闲聊误判为意图。
 * 只在「明确播放动词 + 具体内容」时才命中 play。
 * 日常闲聊如「这首歌真好听」「我喜欢听音乐」不应触发。
 */

export type MusicPlayIntent = { kind: 'play'; query: string };
/** 识别到"想放音乐"但没有具体歌名/歌手（如"播放音乐""来首歌"）——应反问，不能静默不响应。 */
export type MusicPlayGenericIntent = { kind: 'play_generic' };
export type MusicControlIntent = {
  kind: 'control';
  action: 'pause' | 'resume' | 'next' | 'prev' | 'louder' | 'quieter';
};
export type MusicIntent = MusicPlayIntent | MusicPlayGenericIntent | MusicControlIntent;

const TAIL = '[吧呀啊哦呢哈哟嘛吗呗啦咯哇~！!。.，,?？\\s]*$';

// 控制类：明确指令词
const PAUSE_RE = /(?:暂停|停一下|停一停|别放了|先停下|停下|停播|别唱了)/;
const RESUME_RE = /(?:继续播|接着放|继续播放|恢复播放|放下去|继续|接着|别停)/;
const NEXT_RE = /(?:下一首|换一首|切歌|换个|下一曲|换一换)/;
const PREV_RE = /(?:上一首|上一曲|切回上一首)/;
const LOUDER_RE = /(?:大声点|声音大点|大一点|大声|音量大|大点声|再大声)/;
const QUIETER_RE = /(?:小声点|声音小点|小一点|小声|音量小|小点声|小声点|小声些)/;

// 播放类：动词必须明确；后续内容可以没有（如"播放音乐""来首歌"），
// 没有具体歌名/歌手时归为 play_generic（反问），而不是当作无关闲聊静默忽略。
const PLAY_VERB = '(?:放一首|来一首|放首|来首|播放|放个|听一下|听一首|放一放|给我放|放一下|放放)';
const PLAY_RE = new RegExp(`${PLAY_VERB}\\s*([一-龥A-Za-z0-9·]{0,20}(?:\\s*[一-龥A-Za-z0-9·]{0,10}){0,4})${TAIL}`);

export function detectMusicIntent(text: string): MusicIntent | null {
  const normalized = text.trim();
  if (!normalized) return null;

  // 控制优先（短指令更明确）
  if (PAUSE_RE.test(normalized)) return { kind: 'control', action: 'pause' };
  if (RESUME_RE.test(normalized)) return { kind: 'control', action: 'resume' };
  if (NEXT_RE.test(normalized)) return { kind: 'control', action: 'next' };
  if (PREV_RE.test(normalized)) return { kind: 'control', action: 'prev' };
  if (LOUDER_RE.test(normalized)) return { kind: 'control', action: 'louder' };
  if (QUIETER_RE.test(normalized)) return { kind: 'control', action: 'quieter' };

  const play = PLAY_RE.exec(normalized);
  if (play) {
    let query = (play[1] || '').trim();
    // 清洗尾部语气词/的歌
    query = query.replace(/[的歌曲吧呀啊哦呢哈哟嘛吗呗啦~！!。.，,?？\\s]+$/u, '').trim();
    // 有具体内容且不是纯"歌/音乐/一首"等空泛词 → 明确歌曲/歌手意图
    if (query.length >= 1 && !/^(歌|音乐|一首|首歌|一下|点歌)$/.test(query)) {
      return { kind: 'play', query };
    }
    // 命中播放动词但没有具体内容（"播放音乐""来首歌""播放"）→ 反问，不能静默忽略
    return { kind: 'play_generic' };
  }

  return null;
}
