# MyJavis 产品定义(总纲)

> 本文件是 MyJavis 的**总纲**:定义产品目标 + 四层架构,串起三份子定义。深度内容在子文档,本文件只做框架与索引。
> 子文档:① 记忆产品定义 [`Javis-Memory-产品定义-完整版.md`](Javis-Memory-产品定义-完整版.md)(v1.1+§18) · ①b 记忆架构与逻辑 [`Javis-Memory-架构与逻辑.md`](Javis-Memory-架构与逻辑.md)(v2.0) · ② 前端律动 [`Javis-Pulse-前端律动可视化-v1.md`](Javis-Pulse-前端律动可视化-v1.md) · ③ 实现架构 [`ARCHITECTURE-v2.md`](ARCHITECTURE-v2.md) · ④ team 评审 [`REVIEW-memory-team-2026-06-30.md`](REVIEW-memory-team-2026-06-30.md)
> **版本 v1.1** · 更新:2026-06-30(整合前端律动层 + 声纹 + 火山 RTC;记忆系统经 grok+codex 对抗评审后转 MVP 减法,见 ③层 + REVIEW)

---

## 0. 一句话定位

MyJavis = **个人 Jarvis 式实时语音助手**:基于火山引擎 RTC 的全双工低延迟对话,**能区分不同说话人(声纹)**、具备**可控进化的长期记忆(护城河)**,前端是一颗**由语音实时驱动的发光律动球**——随时说、能打断、记得你、且认得出是谁在说。

---

## 1. 产品目标

| # | 目标 | 由哪层兑现 | 状态 |
|---|---|---|---|
| G1 | **实时全双工对话**:随时说、随时打断、整链路 ~1s | 语音 I/O(火山 RTC) | 🟢 骨架可跑 |
| G2 | **区分不同说话人**:多人共享设备时认得出谁在说,按人提供个性化回应 | 身份(火山声纹识别) | 🟡 设计定档,待接 |
| G3 | **抗噪**:嘈杂/多人环境下少误触发、少误打断 | 身份+降噪(声纹降噪/远场抑制) | 🟡 设计定档,待接 |
| G4 | **可控进化的长期记忆**:跨会话记得用户、当天变聪明、夜里巩固塑形,且每步有界可回滚(不漂移) | 记忆护城河(自建三路径) | 🟡 PD 完整,待实现 |
| G5 | **有生命感的前端**:抽象发光律动体实时表现"在听/在想/在说"+声学能量,零素材纯前端 | 前端表现(Javis Pulse) | 🟡 原型 v1 就绪,待集成 |

**护城河(可防御点)**:G4 的**离线巩固(Autodreaming)** + G2/G3 由火山原生兑现后我方在记忆侧的**按身份准入门控**。语音 I/O、向量召回、声纹算法本身都是商品化能力——不在这里建壁垒。

---

## 2. 四层架构(整合图)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ④ 前端表现层  Javis Pulse(纯前端·零素材·解耦)                              │
│     发光律动球 + 波浪线;消费 [phase + 一路音频],不碰业务/记忆               │
│     ▲ phase(火山 conv 状态)   ▲ volume/pitch/rhythm(火山音频属性报告)        │
│     macOS 设备形态 = Tauri 薄壳,复用 apps/web React 核心,不重写 RTC/记忆/律动球 │
├─────┼────────────────────────┼──────────────────────────────────────────┤
│  ①  语音 I/O 层  火山引擎 RTC(全双工/打断/VAD)                              │
│     ASR(流式大模型) → TTS(Doubao) → 全双工 → 字幕/状态回调                   │
├─────────────────────────────────────────────────────────────────────────┤
│  ②  身份层  火山声纹(StartVoiceChat 配置·零自建)                            │
│     识别 Mode=2(≤3人,默认) / 降噪 Mode=1(强抗噪兜底) / 远场抑制 / EnableSV   │
│     → 每轮带 (当前说话人是X) + voiceprintId,热路径免费下发身份                │
├─────────────────────────────────────────────────────────────────────────┤
│  ③  记忆护城河  自建(本地 SQLite·三路径·按 speaker 分账)                     │
│     热(读≤200ms) · 温(写 provisional/可回滚) · 冷(夜间 Autodreaming 对账巩固) │
│     入口 = 服务端 CustomLLM(/v1/chat/completions);不外包给火山 VikingDB     │
└─────────────────────────────────────────────────────────────────────────┘
        火山 RTC = 语音 I/O + 声纹身份传感器(全配置化) │ 我方 = 记忆大脑 + 前端表现
```

详见 [`ARCHITECTURE-v2.md`](ARCHITECTURE-v2.md)(实现蓝本,含模块结构/接口契约/Phase0)。

---

## 3. 各层定位与红线

### ① 语音 I/O(火山 RTC)
全双工对话、ASR/TTS、打断、VAD 全在火山。我方不自建实时音频栈。CustomLLM 模式:火山管语音,LLM(大脑)留我方。

### ② 身份(火山声纹) —— 见 [记忆 PD §17](Javis-Memory-产品定义-完整版.md)
- **默认 A**:声纹识别 `Mode=2`(≤3人)+ 远场抑制 + 记忆按身份门控。
- **兜底 B**:需强降噪时切声纹降噪 `Mode=1`(单人强抗背景人声),`voiceMode` 重连切换。
- 身份是记忆的"第一公民":`unknown`/低置信轮次**不写任何人长期记忆**(抗串账红线)。

### ③ 记忆护城河(自建) —— 产品定义见 [完整版](Javis-Memory-产品定义-完整版.md),架构与逻辑见 [架构与逻辑](Javis-Memory-架构与逻辑.md)

**结构 = 一个本地 SQLite 存储 + 三条按延迟分层的路径 + 一条贯穿的身份线**:

```
火山回调(文本+历史+说话人X) ─► [custom-llm 记忆大脑入口]
  ├ 热路径(读 ≤200ms)  HotRead: 并行 向量∥BM25∥实体 召回 + 偏好/人格查表(按 speaker)→ 注入 prompt
  ├ 温路径(写 答后异步) 身份门 → 候选抽取(确定性) → admit() → 冲突条件化 → 写 provisional(可回滚)
  └ 冷路径(夜间 cron)   Autodreaming: 对账(provisional→commit/discard)+压缩+反思+遗忘+人格更新
存储: SQLite(committed/provisional 分区 · 按 speaker_id 分账 · sqlite-vec)
```

> **v2 修订(team 评审后,2026-06-30)**:经 grok+codex 对抗评审,记忆系统转 **MVP 减法**。以下为修订后口径;完整裁决见 [REVIEW](REVIEW-memory-team-2026-06-30.md),实现见 [架构与逻辑 v2.0](Javis-Memory-架构与逻辑.md)。

- **身份地基(致命修复)**:火山 voiceprintId **不当长期主键**——引身份证据层(SpeakerEvidence 状态机 + memory_owner_id + quarantine),非 active_stable 不写长期(防串账)。
- **MVP 数据 = 单 typed_memory 表**(preference/event/reminder/profile/safety/...),**不做 L2 通用三元组**;按 owner + namespace(private/shared/session)分账。L2 语义/人格 disposition/反思 **暂缓**,指标 gate 后再加。
- **commit 按 typed 生命周期**(替"reinforced≥N 才 commit"——那会忘掉一次性航班/过敏):显著/安全类一次直通 committed。提交边界(provisional/committed)保留,但**砍重型夜间 reconcile 引擎**。
- **记忆作 data 不作 instruction(安全致命)**:结构化渲染注入 + 防持久化 prompt injection,记忆不得覆盖系统规则。
- **抗漂移红线**:身份门 · source_role 溯源(assistant 文本不作用户事实)· 记忆作 data · 有界/可回滚/可观测 · 热路径无 LLM/无图 + timeout 降级。
- **隐私治理**:查看/忘掉/重归属/暂停/导出 + 敏感短TTL/加密 + 纠正带权限。
- **护城河重定义**:不是"离线巩固机制"(谁都能抄),而是**长期个体化数据 + 纠错闭环 + 低串账率 + 信任/隐私治理 + 评测体系 + 实时体验**;**不外包给火山 VikingDB**。

### ④ 前端表现(Javis Pulse) —— 见 [前端律动 v1](Javis-Pulse-前端律动可视化-v1.md)
- 抽象发光律动体,**不是人脸/avatar/lipsync**(那是 v2 可选,与本层解耦)。
- 纯前端 Canvas 2D、零素材、音频驱动。**只消费 phase + 信号,不读写记忆/业务数据。**
- 与火山集成:phase ← `conv` 状态;volume/pitch/rhythm ← 火山 `enableAudioPropertiesReport`(linearVolume/voicePitch/spectrum),走 `pushSignals()`(详见前端 v1 §13)。
- 声纹身份标签、字幕属并列的另一套 UI,与律动球同层、互不依赖。

---

## 4. 仍待川哥拍板(开放项)

| 项 | 现状 |
|---|---|
| **人设 / 语气 / 称呼 / 安全红线** | ⬜ 待定(记忆 L3 人格基座、custom-llm 的 persona) |
| **LLM 选型**(须 OpenAI 兼容,RTC CustomLLM 路径) | ⬜ 待定;是否要 function call(控智能家居/查日历) |
| **声纹 ≤3 人上限**对家庭场景够不够 | ⬜ 待确认(超 3 人需兜底设计) |
| **设备形态** | ✅ macOS（Tauri 薄壳 + Web 核心复用） |
| **前端开放项**(thinking 视觉、最终配色、过渡缓动) | ⬜ 见前端 v1 §12 |
| **v2 方向:点云脸**(docs/face.png) | ⬜ 律动球作环绕能量场,与脸融合(前端 v1 §11 路线图) |

---

## 5. 非目标(明确不做)

- ✗ 不自建实时音频栈(ASR/TTS/全双工/声纹/降噪 全用火山原生)。
- ✗ 不把记忆护城河外包给火山 VikingDB 托管记忆库。
- ✗ 前端不做人脸/lipsync(v1);律动层不读写任何业务/记忆数据。
- ✗ 不默认用 LLM classifier 做记忆准入;不让反馈信号自动改写准入策略(见记忆 PD §7/§9)。
- ✗ 不以刷公开 benchmark 为目标。
