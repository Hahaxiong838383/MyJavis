/**
 * 语义分桶承接句（文本版，借鉴 realtime-voice-agent engines/fillers.py 的分桶范式）。
 *
 * 架构差异：cascade 那边是预合成 wav 帧 + say() 音频级插播；MyJavis 是火山 CustomLLM
 * 文本 SSE——承接句直接作为首个 content chunk 吐出，火山 TTS 现场合成，正文随后无缝接。
 * 因此没有「文案时长 vs 回复就绪」平衡木（文本按序念），也不需要 wav 资产管线。
 *
 * 自适应（比固定插更优）：custom-llm 侧先等 FILLER_WAIT_MS 窗口，LLM 首 token 先到就
 * 不插（快场景零开销）；窗口先到才插（LLM 慢/兜底接管场景，感知开口 ~0.4s）。
 *
 * 分桶规则原样移植（纯子串零延迟，task 优先于 ask：“帮我讲个故事好不好”回“好嘞”
 * 比“我想想”贴切）；文案按 Javis 成人助手人设重写，刻意短（3-6 字，TTS 合成快）。
 */

/**
 * 分桶与文案依据《人类日常对话句式全面指南》(2026-07,川哥提供)重设计:
 * - 桶 3→5:新增 emo(情绪/抱怨,指南§10/§12/§六.6「情绪输入优先共情而非建议」)、
 *   share(叙述分享,§1.8 Backchanneling「嗯/哦?/是嘛」维持对话)。
 * - 每桶 5-8 变体(§六.1「同一意图至少 5-8 种回复变体」),语气词按 §四.1 表点缀(哈/嘛/啊/嗯嗯)。
 * - 优先级 emo > task > ask > share > gen:情绪最优先(共情压倒功能);task>ask 沿袭
 *   realtime-voice-agent 结论(「帮我讲个故事好不好」回「好嘞」比「我想想」贴切)。
 * - 设计红线:承接句不预设 LLM 立场——观点/评价类输入不承接「对啊/没错」
 *   (正文若反对则自相矛盾),一律走中性思考型;task 桶「没问题」类轻微预设可接受(请求类
 *   LLM 极少拒绝,cascade 版同款已验收)。
 */

const EMO_HINTS = ['累', '烦', '难过', '难受', '生气', '郁闷', '焦虑', '压力', '唉', '头疼', '崩溃', '委屈', '心情不好', '不开心', '想哭', '气死'] as const;
const TASK_HINTS = ['讲', '说个', '说一', '给我', '帮我', '来个', '来一', '推荐', '介绍', '教我', '安排', '查', '算', '写', '做个', '订', '提醒', '记住', '找', '规划'] as const;
const ASK_HINTS = ['怎么', '为什么', '什么', '哪', '几', '多少', '是不是', '吗', '呢', '好不好', '行不行', '对不对', '?', '？'] as const;
const SHARE_HINTS = ['我跟你说', '你猜', '今天', '刚才', '昨天', '我发现', '遇到', '见到', '碰到', '你知道'] as const;

export type FillerBucket = 'emo' | 'task' | 'ask' | 'share' | 'gen';

export function pickBucket(userText: string): FillerBucket {
  const t = (userText || '').trim();
  if (EMO_HINTS.some((h) => t.includes(h))) return 'emo';
  if (TASK_HINTS.some((h) => t.includes(h))) return 'task';
  if (ASK_HINTS.some((h) => t.includes(h))) return 'ask';
  if (SHARE_HINTS.some((h) => t.includes(h))) return 'share';
  return 'gen';
}

const PHRASES: Record<FillerBucket, string[]> = {
  // 共情接住情绪,正文再展开安慰(指南§10:共情+安慰/简单陪伴「我在呢」)
  emo: ['哎，咋啦。', '嗯，我在听。', '哎呀。', '怎么了怎么了。', '嗯嗯，你说。', '哎，别急。'],
  // 爽快应承(指南§4「爽快同意:好啊/没问题/行」+§7 谦虚型口吻)
  task: ['好嘞。', '没问题。', '收到，稍等哈。', '行，我来。', '好说。', '马上安排。', '这就来。', '好，我看看。'],
  // 思考型填充(指南§四.2「嗯…/怎么说呢…」+§五「让我想想/看情况吧」),中性不预设
  ask: ['嗯，我想想。', '让我看看啊。', '这个嘛……', '怎么说呢……', '好问题。', '我查查哈。', '让我捋一捋。'],
  // Backchannel 倾听(指南§1.8「嗯/哦?/是嘛/真的假的/哇」)
  share: ['哦？', '是嘛。', '嗯嗯。', '哇。', '真的假的。', '哈哈。'],
  // 兜底短应答(指南§1.8 简单确认)
  gen: ['嗯。', '嗯嗯。', '哦。', '好。', '哎。'],
};

/** 概率门控 + 语义桶 + 防连续重复（范式三件套的文本版）。 */
export class FillerPicker {
  private lastText: string | null = null;
  constructor(private probability: number) {}

  pick(userText: string): string | null {
    if (Math.random() >= this.probability) return null;
    const pool = PHRASES[pickBucket(userText)] ?? PHRASES.gen;
    const cands = pool.filter((p) => p !== this.lastText);
    const choice = (cands.length ? cands : pool)[Math.floor(Math.random() * (cands.length ? cands.length : pool.length))]!;
    this.lastText = choice;
    return choice;
  }
}

export const fillerConfig = {
  enabled: (process.env.FILLER_ENABLED ?? '1') !== '0',
  /**
   * 承接句延迟窗口。默认 0 = 收到回调立即吐（川哥 2026-07-02 拍板：承接要像真人的
   * 「嗯」一样瞬间接上，即时反馈优先于简洁）。设 >0 变自适应：LLM 首 token 在窗口内
   * 到达则不插（曾试 750ms 快轮不插方案，听感上承接慢半拍，弃）。
   */
  waitMs: Number(process.env.FILLER_WAIT_MS ?? 0),
  probability: Number(process.env.FILLER_PROBABILITY ?? 1),
};

/** 进程级单例（防连续重复跨请求生效）。 */
export const fillerPicker = new FillerPicker(fillerConfig.probability);
