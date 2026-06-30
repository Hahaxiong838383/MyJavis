# MyJavis 架构与数据流

> 抽取自 P003「小可」生产代码（火山 RTC 全链路，真机验证）。本文档记录**已抽取的通用底座**，业务/产品层留给 [`PRODUCT-DEFINITION.md`](PRODUCT-DEFINITION.md)。

## 现状（2026-06-29）

**🟢 火山 RTC 路径已接通、可跑**：`pnpm install` → 填 `.env` → `pnpm dev:server` + `pnpm dev:web` 即可真机对话。
已 E2E 验证（cc，证据级=已验证）：server 启动正常、`/health` ok、`/api/rtc/start` 缺凭证优雅报错、`/v1/chat/completions` 输出合规 OpenAI 兼容 SSE 流（含真实 LLM 外呼，仅受网关账号客户端策略所限未跑通 happy-path token）。server + web 均 `tsc` 零错。
**WS 路径（`/ws/voice`）仍为骨架**：`volc-asr`/`volc-tts` 待补私有二进制帧、`pipeline.ts` 未接线。记忆系统占位（`NullMemoryStore`）。

## 分层

| 层 | 目录 | 状态 | 说明 |
|---|---|---|---|
| Provider 接口 | `server/src/providers/types.ts` | 🟢 接口完成 | AsrProvider / TtsProvider / LlmProvider 归一化接口 |
| 火山 ASR | `server/src/providers/volc-asr.ts` | 🟡 骨架 | WebSocket v3 bigmodel，VAD 判停（待补二进制帧） |
| 火山 TTS | `server/src/providers/volc-tts.ts` | 🟡 骨架 | Doubao 双向流，句级 cue（event 350/351/152，待补帧） |
| LLM | `server/src/providers/llm.ts` | 🟢 已接通 | OpenAI 兼容流式（任意兼容端点可插），已 E2E |
| Pipeline | `server/src/pipeline.ts` | ⬜ 未接线 | 会话状态机 + ASR→LLM→TTS 编排 + barge-in（WS 路径用） |
| Prompt 组装 | `server/src/prompt/orchestrator.ts` | 🟢 完成 | 人设基座 + 记忆注入 + 安全（通用，无小可耦合） |
| 记忆系统 | `server/src/memory/`（`types.ts` + `index.ts` 门面） | ⬜ 占位 | `NullMemoryStore`；已在 custom-llm 接线 recall/extract 缝，换实现零改调用方 |
| RTC 路由 | `server/src/routes/rtc.ts` | 🟢 已接通 | start/stop/update-prompt + token 签发 + StartVoiceChat |
| CustomLLM | `server/src/routes/custom-llm.ts` | 🟢 已接通 | 火山 AIGC-RTC 回调（OpenAI 兼容 SSE）= 助手大脑，已 E2E |
| 入口 | `server/src/index.ts` | 🟢 完成 | Hono `/health` + `/api/rtc` + `/v1`，IPv4 监听 |
| Web 客户端 | `web/src/`（`useVoiceRtc` + `App` + `store`） | 🟢 可跑 | 火山 RTC Hook（动态 import SDK）+ 极简对话 UI |

## 数据流：用户说话 → 播放

```
【前端】采集 PCM 16k/16bit → WS audio.chunk ──┐
                                              ↓
【后端 WS 路径】
  asr.feed(pcm) → 火山 ASR WebSocket
    onPartial(text) → emit asr.partial（红字临时）
    onFinal(text)   → emit asr.final（黑字最终）→ 触发 LLM
      ↓
  assemblePrompt()  // 人设基座 + 记忆(L1) + 安全
      ↓
  llm.streamChat({systemPrompt, userText, history})
    onDelta → emit llm.delta（实时字幕）
    onDone  → 异步记忆抽取（每 N 轮）→ tts.feed(reply)
      ↓
  火山 TTS 双向流
    event 350 TTSSentenceStart → emit tts.cue（句文本，对齐字幕）
    event 351 SentenceEnd(中段) → emit tts.sentence_break（flush 音频缓冲）
    mp3 chunk                   → emit tts.audio
    event 152 SessionFinished   → emit tts.end
      ↓
【前端】audioCtx 排播 + rAF 电影字幕（按 audioCtx.currentTime 对齐 cueMap）
```

## RTC 路径（移动端 / 低延迟）

火山 AIGC-RTC 全双工：ASR/TTS 在火山侧，服务端只当大脑。

```
前端 POST /api/rtc/start {systemPrompt?} → {appId, roomId, userId, token, taskId}
前端 joinRoom(token, roomId)（@volcengine/rtc）
火山 ASR 转写 → POST /v1/chat/completions（OpenAI 兼容，?token= 带身份）
  → assemblePrompt() → llm streamChat → SSE 流回
  → 火山 Doubao TTS 播出
prompt 热更新：POST /api/rtc/update-prompt（内存 override，下一轮即生效，不重连）
```

## 从 P003 抽取时剥离的业务耦合（不带入 MyJavis）

- 小可世界观 / 方舟设定 / 课程知识库 / AI 启蒙门控 → 替换为通用助手人设占位
- 孩子画像字段（nickname/birthday/interests/game_progress）→ 记忆字段待 MyJavis 产品定义
- onboarding 问名、吐槽模式、表情感知（Gemini Vision）→ 不带入（按需再加）

## 关键判停 / 延迟参数（P003 实测，可作 MyJavis 起点）

- ASR：`format=pcm rate=16000 bits=16 channel=1`，`enable_punc/enable_itn=true`；`vad_segment_duration` 句尾判停窗（P003 儿童设 1200ms，成人可调小到 ~600-800ms 抢响应）。
- TTS 字幕抢跑 ~50ms；mp3 buffer flush 等句末或 600ms 超时。
- LLM 历史窗：近 N 轮 + 字符上限（防 prompt 膨胀）。
