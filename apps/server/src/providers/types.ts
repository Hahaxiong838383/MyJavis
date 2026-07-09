/**
 * Provider 归一化接口 —— MyJavis 的可插拔边界。
 *
 * 抽取自 P003 的 volc-asr / volc-tts / gemini-llm，统一成三个接口，
 * 让火山以外的 ASR/TTS/LLM 也能替换进来（产品定义阶段可能换 LLM）。
 */

// ===== ASR =====
export interface AsrCallbacks {
  /** 临时识别结果（红字，definite=false） */
  onPartial?: (text: string) => void;
  /** 最终识别结果（黑字，definite=true）→ 触发 LLM */
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
}

export interface AsrProvider {
  /** 建立识别会话（如火山 WebSocket 握手） */
  start(cb: AsrCallbacks): Promise<void>;
  /** 喂 PCM 16bit/16k 音频块 */
  feed(pcm: Buffer): void;
  /** 通知音频结束（手动 EOF） */
  end(): void;
  close(): void;
}

// ===== TTS =====
export interface TtsCallbacks {
  /** 句开始：权威句文本，用于字幕对齐（火山 event 350） */
  onCue?: (index: number, text: string) => void;
  /** 句末标点（中段）：flush 音频缓冲（火山 event 351，注意不是流结束） */
  onSentenceBreak?: (index: number) => void;
  /** mp3 音频块（base64 或 Buffer），带所属句序号 */
  onAudio?: (chunk: Buffer, sentenceIndex: number) => void;
  /** 真正的流结束（火山 event 152 SessionFinished） */
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

export interface TtsProvider {
  start(cb: TtsCallbacks): Promise<void>;
  /** 喂待合成文本（可流式分句喂入） */
  feed(text: string): void;
  /** 文本结束 */
  finish(): void;
  close(): void;
}

// ===== LLM =====
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** OpenAI 兼容 function-calling 工具定义（tools 数组元素）。 */
export interface LlmToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmStreamArgs {
  systemPrompt: string;
  userText: string;
  history: ChatTurn[];
  /**
   * 本轮上下文注（如声纹身份）：以 system 消息插在 history 之后、当前 user 之前——
   * 近因最强位。放 systemPrompt 尾部会被 history 惯性压过（真机实证：history 里
   * assistant 说过"认错了"，LLM 就无视 system 尾部身份段继续说不认识）。
   */
  contextNote?: string;
  /** 本轮可用工具（如 music_control）。带工具时按 Gate1 探测结论走单路（见 llm.ts），不赛马。 */
  tools?: LlmToolDef[];
  onDelta: (chunk: string) => void;
  onDone: (full: string) => void;
  onError?: (err: Error) => void;
  /** 流式 tool_call 聚合完成（finish_reason=tool_calls 或流结束）时触发；argsJson 为原始未解析字符串。 */
  onToolCall?: (name: string, argsJson: string) => void | Promise<void>;
  signal?: AbortSignal; // 支持 barge-in 中断
}

export interface LlmProvider {
  /** 流式对话。必须 OpenAI 兼容（RTC CustomLLM 路径要求） */
  streamChat(args: LlmStreamArgs): Promise<void>;
}
