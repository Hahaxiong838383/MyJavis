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

const TASK_HINTS = ['讲', '说个', '说一', '给我', '帮我', '来个', '来一', '推荐', '介绍', '教我', '安排', '查', '算'] as const;
const ASK_HINTS = ['怎么', '为什么', '什么', '哪', '几', '多少', '是不是', '吗', '呢', '好不好', '行不行', '对不对', '?', '？'] as const;

export type FillerBucket = 'task' | 'ask' | 'gen';

export function pickBucket(userText: string): FillerBucket {
  const t = (userText || '').trim();
  if (TASK_HINTS.some((h) => t.includes(h))) return 'task';
  if (ASK_HINTS.some((h) => t.includes(h))) return 'ask';
  return 'gen';
}

const PHRASES: Record<FillerBucket, string[]> = {
  task: ['好嘞。', '没问题。', '收到。', '马上。'],
  ask: ['嗯，我想想。', '让我看看。', '稍等哈。'],
  gen: ['嗯。', '好的。'],
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
