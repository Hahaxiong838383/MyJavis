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

// 控制类：明确指令词（对齐主流音箱/车机常用说法）
// ⚠️ 2026-07-04 真机踩坑：用户说"停止播放"ASR 转录完全正确，但原正则只有"停下/停播"
//    没有"停止"这个最常用词 → 未命中 → 落进普通对话。补全"停止"。
// "关"系列要求带"音乐"（裸"关了/关掉"会撞"把灯关了"），宁漏勿误。
const PAUSE_RE = /(?:暂停|停止|停一下|停一停|别放了|先停下|停下|停播|别唱了|静音|关(?:掉|了|闭)音乐)/;
// 裸"继续/接着"不收录：日常对话高频用于"继续说/继续做"等非音乐语境
// （测试发现"继续听我说完"会被误判成 resume），必须搭配"放/播/唱"才算明确音乐指令。
const RESUME_RE = /(?:继续播|接着放|继续播放|恢复播放|放下去|继续放|接着唱|别停)/;
// "换个"不收录（撞"换个话题/换个地方"），要求"一首/首/曲/歌"锚定。
// 2026-07-08 川哥真机："我们换一个话题"被"换一个"误判成切歌（回"还没放歌"）——
// "换一个/换一换/上一个"无音乐锚定词，全部剔除（"换一首/切歌/上一首"覆盖已足够，宁漏勿误）。
const NEXT_RE = /(?:下一首|换一首|切歌|下一曲|下首歌|再来一首|换首歌)/;
const PREV_RE = /(?:上一首|上一曲|切回上一首|返回上一首)/;
const LOUDER_RE = /(?:大声点|声音大点|大一点|大声|音量大|大点声|再大声)/;
const QUIETER_RE = /(?:小声点|声音小点|小一点|小声|音量小|小点声|小声点|小声些)/;

// 播放类：动词必须明确；后续内容可以没有（如"播放音乐""来首歌"），
// 没有具体歌名/歌手时归为 play_generic（反问），而不是当作无关闲聊静默忽略。
// 2026-07-04 真机连续两轮暴露覆盖不够（"我想听X的""随便播个X"未命中）——
// 加"我想听/想听/要听"等明确表达意愿的前缀 + "播个"（原来只有"放个"）。
// "听听"变体在"听"之前（JS 交替从左优先）：曾把"我想听听周杰伦的歌"捕获成"听周杰伦"
// 搜出《英国老外听周杰伦》reaction 视频（2026-07-06 真机日志实锤）。
const PLAY_VERB =
  '(?:我想听听|想听听|我想听|我要听|想听|要听|放一首|来一首|放首|来首|播放|放个|播个|听一下|听一首|放一放|给我放|放一下|放放|帮我放|帮我播)';
const PLAY_RE = new RegExp(`${PLAY_VERB}\\s*([一-龥A-Za-z0-9·]{0,20}(?:\\s*[一-龥A-Za-z0-9·]{0,10}){0,4})${TAIL}`);
// 兜底：裸"听"+具体内容(2字以上)+"的"（如"听周杰伦的"）。要求至少2字+"的"结尾，
// 避免"听着""听懂""听说"这类常见非音乐用法（1-2字无"的"）被误判。
const BARE_LISTEN_RE = /听([一-龥A-Za-z0-9·]{2,12})的/;

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
    // 头部量词剥离："播放"在位置 0 抢占匹配（"放一首"排更后但位置靠右），捕获会带上
    // "一首/首/个"（2026-07-06 真机根因之一："播放一首夜曲"捕获"一首夜曲"）
    query = query.replace(/^(?:一首|一个|一段|首|个|点)\s*/u, '');
    // 尾部清洗：⚠️ 只删完整词组+语气词，绝不能用含"歌/曲"的字符类逐字吞——
    // 曾把"夜曲"的"曲"字砍掉变"一首夜"，B 站搜出《把惊魂夜唱成一首歌》(蛋仔派对)
    // 冲顶（2026-07-06 真机根因之二，看似"搜索质量差"实为 query 被啃坏）。
    query = query
      .replace(/(?:的歌曲|的歌|的曲子|的音乐|这首歌)$/u, '')
      .replace(/[吧呀啊哦呢哈哟嘛吗呗啦~！!。.，,?？\s]+$/u, '')
      .replace(/(?:的歌曲|的歌|的曲子|的音乐)$/u, '') // 语气词剥完可能再露出"的歌"（"放晴天的歌吧"）
      .replace(/的$/u, '') // 裸"的"收尾（判停截断"我想听周杰伦的[X]"）：搜"周杰伦的"曾冲顶《周杰伦的床边故事》合集
      .trim();
    // 有具体内容且不是纯"歌/音乐/一首"等空泛词 → 明确歌曲/歌手意图
    // "一"单列：interim 截断"播放一[首X]"捕获裸"一"，当 generic 反问而非搜"一"
    if (query.length >= 1 && !/^(歌|音乐|一首|首歌|一下|点歌|歌曲|一)$/.test(query)) {
      return { kind: 'play', query };
    }
    // 命中播放动词但没有具体内容（"播放音乐""来首歌""播放"）→ 反问，不能静默忽略
    return { kind: 'play_generic' };
  }

  const bareListen = BARE_LISTEN_RE.exec(normalized);
  if (bareListen) {
    const query = (bareListen[1] || '').trim();
    if (query.length >= 1) {
      return { kind: 'play', query };
    }
  }

  return null;
}
