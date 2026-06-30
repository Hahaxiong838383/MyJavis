# MyJavis 架构 v2.1 —— 火山 RTC × 记忆(MVP) × 声纹身份

> **版本 v2.1**(2026-06-30,记忆部分按 team 评审转 MVP 减法;v2.0 见 git)。对齐文档,把记忆/声纹/前端三份子定义映射到实现架构。取代 [`ARCHITECTURE.md`](ARCHITECTURE.md) 作实现蓝本。
> 记忆系统内部架构+逻辑(v2.0,身份证据层/事件溯源/typed 生命周期/memory-as-data/MVP)详见 [`Javis-Memory-架构与逻辑.md`](Javis-Memory-架构与逻辑.md);评审裁决见 [`REVIEW-memory-team-2026-06-30.md`](REVIEW-memory-team-2026-06-30.md)。
>
> **证据级**:火山 RTC 能力均标注「已验证(火山官方文档页码)」;架构推导标「设计」。
> 一句话:**火山 RTC = 语音 I/O + 声纹身份传感器(全配置化、零自建);我方 = 记忆大脑(MVP 起步,本地自建自控)。**

---

## 0. 三句话定位

1. **不自建实时音频栈**:ASR/TTS/全双工/打断/VAD/**声纹识别·降噪·远场抑制·说话人验证**全是火山 `StartVoiceChat` 的配置(已验证,页 7479–7493)。MyJavis 的工程重量不花在这。
2. **不外包记忆护城河**:火山有 VikingDB 托管记忆库(已验证,页 7338),但那是 PD §0.3 点名的"商品化向量召回"。我们只用火山的语音+身份,**记忆的准入/巩固/遗忘/人格全部自建**(三路径 + Autodreaming)。
3. **工程重量落在温/冷路径**:个人尺度本地部署,热路径 ≤200ms 几乎白送;难点和护城河在写路径准入 + 夜间对账,与 PD 论点一致。

---

## 1. 系统总览

```
┌─────────────────────────── 火山 RTC 云(语音 I/O + 声纹身份) ───────────────────────────┐
│  ASR(流式大模型) · TTS(Doubao) · 全双工/barge-in · VAD                                    │
│  声纹识别 Mode=2(≤3人) → voiceprintId/Name + (当前说话人是X)标签                          │
│  远场人声抑制 FarfieldConfig · 说话人验证 EnableSV                                         │
└───────▲──────────────────────────┬──────────────────────────────────▲───────────────────┘
        │ joinRoom(token)          │ 每轮回调(含说话人标签)              │ 声纹状态 stat 回调
        │   ▲ phase(conv) + 音频属性报告(linearVolume/voicePitch/spectrum,local+remote)
        │   │                      ▼                                    │
   ┌────┴───┴───────────┐ POST /v1/chat/completions?session=room&user=… │
   │  Web/端             │      (OpenAI 兼容 SSE)                        │
   │  useVoiceRtc        │          │                                   │
   │   └►④ JavisPulse 律动层(纯前端,消费 phase+信号,不碰记忆/业务)        │
   └────────────────────┘          ▼                                   │
                    ┌──────────── MyJavis Server(Hono) ───────────┐     │
   POST /api/rtc/start│  routes/custom-llm  ←─ 记忆大脑入口          │     │
   (签 token+RegisterVoicePrint  │   ① Identity.resolve→ownerId|quarantine │     │
    +StartVoiceChat 带声纹配置)──│   ② memory.recall(按 owner,hot cache)─┐ │     │
                                 │   ③ assemblePrompt(persona+【data化记忆】)│ │   │
                                 │   ④ LLM streamChat ─► SSE 回火山 │   │     │
                                 │   ⑤ onDone:memory.remember(EventLog finalized utterance)│
                                 └───────────────┬──────────────────────┘     │
                                                 ▼                            │
                        ┌──── Memory 大脑(本地自建,SQLite WAL · MVP)──────────┐    │
                        │ 身份: SpeakerEvidence 状态机 → memory_owner_id        │    │
                        │ 热: HotCache(摘要)优先 + 单路检索(关键词/结构化)      │    │
                        │ 温: 身份门 → hybrid 抽取 → admit → typed 生命周期      │    │
                        │ 冷(轻): TTL + 去重 + 冲突 compaction + 指标            │    │
                        │ 存: memory_item(typed) · committed/provisional/quarantine · namespace+ACL · 按 owner │
                        │ 暂缓: 向量召回 / L2三元组 / 人格 / 反思 (指标 gate)    │    │
                        └──────────────────────────────────────────────────┘
```

---

## 2. 火山 RTC 能力清单(已验证,作为配置真值)

> 全部经《实时音视频 RTC 文档指南》§2.3.9/2.3.10(页 7479–7493)、§2 会话式 AI 总览(页 7338–7340)核实。

### 2.1 声纹(`AgentConfig.VoicePrint`)
- `Mode=2` 声纹识别:区分谁在说,`IdList`(≤3 个 VoicePrintId)+ `Score`(40–60)。**ASR 须流式且 `StreamMode≠1`**。
- `Mode=1` 声纹降噪:只留 1 个主讲人,抑制背景人声(公测)。
- `EnableSV=true`:说话人验证,声纹匹配才触发 AI 回复(= 门控)。
- 注册:OpenAPI `RegisterVoicePrint`→`VoicePrintId`(`UpdateVoicePrint` 更新);或通话中自学习(`VoiceDuration` 6/12/20s,无需 IdList)。
- ⚠️ **`Mode` 单值,识别与降噪二选一**;声纹功能与 AI 降噪(`AnsMode`)互斥;注册与通话采集设备须一致。

### 2.2 降噪/抗干扰
- 远场人声抑制 `ASRConfig.FarfieldConfig`(Level High/Medium/Low + Threshold 0–127):滤 3–5 米外低能量人声,**仅火山 ASR 大模型生效**,与声纹兼容。
- AI 降噪 `AgentConfig.AnsMode`(1 轻/2 中/3 重):滤非人声,**与声纹互斥**。
- 音量增益 `ASRConfig.VolumeGain`(默认 1.0)。
- 打断保护 `ASRConfig.InterruptConfig.InterruptSpeechDuration`(建议 ≥1500ms)、首帧打断 `VADConfig.ForceBeginThreshold`。

### 2.3 身份 → LLM/记忆 的原生通道(关键)
- 开启 `Mode=2` 后:① 实时字幕回调带 `voiceprintId`/`voiceprintName`;② 火山在送 CustomLLM 的消息里注入 `(当前说话人是{AudioName})` 标签;③ `SystemMessages` 可引导 LLM 按身份回应。
- 声纹状态:客户端 `onRoomBinaryMessageReceived` magic=`stat`,status ∈ Disabled/Registering/**Active**。

### 2.4 MyJavis 选定组合:A 默认 + B 兜底,`voiceMode` 开关切换(川哥拍板 2026-06-29)

**默认 A（识别/多人）**:
```jsonc
// StartVoiceChat(节选,voiceMode='identify')
"AgentConfig": {
  "VoicePrint": { "Mode": 2, "IdList": ["<vp_chuan>", "..."], "Score": 50 }
  // 不设 AnsMode(与声纹互斥)
},
"Config": {
  "ASRConfig": {
    "FarfieldConfig": { "Enable": true, "Level": "Medium" },
    "InterruptConfig": { "InterruptSpeechDuration": 1500 },
    "ProviderParams": { "StreamMode": 0 }
  },
  "LLMConfig": { "Mode": "CustomLLM", "Url": ".../v1/chat/completions?session=<room>" }
}
```
**兜底 B（强降噪/单人,voiceMode='denoise')**:`VoicePrint` 改 `{ "Mode": 1, "IdList": ["<vp_chuan>"], "EnableSV": true }`,其余同。

**切换机制(已验证·火山文档页 6587–6588)**:`Mode` 是 `StartVoiceChat` 配置;`UpdateVoiceChat` **仅支持 `Command: interrupt|function`,改不了声纹模式** → **A↔B 切换必须重连**(stop + 用另一 mode 重新 start)。
- `voiceMode: 'identify'(默认) | 'denoise'` 作 `/api/rtc/start` 的 start-time 参数;前端给切换开关;切换 = `stop()` 后带新 `voiceMode` 重新 `start()`(耗时几秒,低频可接受)。
- **记忆侧:B = A 的单说话人退化情形**,同一套 schema/准入,B 下记忆全归属那 1 个目标用户,数据模型零改。
- **待确认**:≤3 人识别上限对家庭场景是否够。

---

## 3. 三路径 → 代码落点

> 记忆系统内部的**组件架构 + 端到端逻辑(三条流的逐步逻辑、admit/对账伪码、数据表、生命周期状态机)**见专文 [`Javis-Memory-架构与逻辑.md`](Javis-Memory-架构与逻辑.md)。本节只给系统级落点。

| PD 路径 | 落点 | 延迟预算 | 允许做 |
|---|---|---|---|
| **热(读)** | `custom-llm` 收火山回调 → LLM 前的 `recall+assemblePrompt` | p95 ≤200ms | 工作记忆 + 向量/BM25/实体并行召回 + 偏好/人格查表(**按身份**) |
| **温(写)** | `custom-llm` 的 `onDone` 后异步 | 秒级 | `admit()` 确定性打分 + 在线适应(provisional,**按身份分账**) |
| **冷(夜间)** | 独立 cron 进程 `autodreamer`,**不在请求路径** | 分钟级 | 对账(provisional→commit/discard) + 压缩 + 反思 + 遗忘 + 人格 |

**身份贯穿三路径**:火山热路径下发 `speaker_id` → recall 取该人记忆 → admit 写该人分区 → 夜间对账各人独立。`unknown`/低置信轮次:可回复(通用语气)但**不写任何人长期记忆**(PD §17.4 抗漂移红线)。

---

## 4. 目标模块结构(server + web)

```
apps/server/src/
  index.ts                  入口(/health + /api/rtc + /v1)
  routes/
    rtc.ts                  start/stop/update-prompt + 声纹配置 + RegisterVoicePrint 代理
    custom-llm.ts           记忆大脑入口:解析身份 → recall → assemble → stream → (onDone)写
    voiceprint.ts  [新]     声纹注册/更新 OpenAPI 封装(RegisterVoicePrint/UpdateVoicePrint)
  session/        [新]      会话态(roomId 为键):L0 环形缓冲 + 上一轮(user,assistant)对 + provisional session delta
  memory/                   ★ 护城河(本地自建)
    types.ts                三路径接口契约(下 §5)
    storage.ts     [新]     SQLite 抽象:committed/provisional 分区 + speaker_id 分账 + TTL
    hot-read.ts    [新]     recall():working+向量+BM25+实体+偏好查表(无 LLM/无图)
    admission.ts   [新]     admit():确定性打分(salience/novelty/conflict/type+身份门),带 rationale
    online-adapt.ts[新]     provisional delta(有界/可回滚/可观测)
    autodreamer.ts [新]     冷路径作业(被 cron entry 调用)
    speaker.ts     [新]     Speaker Registry:speaker_id↔profile
  prompt/orchestrator.ts    persona(L3 数据,非常量)+ 记忆注入 + 安全;taskSuffix 永远末尾(近因)
  llm/openai-compat.ts      (现 providers/llm.ts)流式,可插拔
  telemetry.ts   [新]       Phase0 埋点:每轮 (turn,身份,召回命中,各段耗时,注入token) → 回放语料+指标
apps/autodreamer/  [新]     夜间 cron entry(复用 mycc scheduler / launchd),调 memory/autodreamer.ts

apps/web/src/
  useVoiceRtc.ts            火山 RTC Hook(进房/字幕/状态);加 enableAudioPropertiesReport → 喂 pulse
  pulse/         [新]       Javis Pulse 律动层(从 prototype/javis-pulse-v1.html 抽成组件)
    JavisPulse.ts           mount/setPhase/connectAudio/pushSignals/setTheme/destroy(前端 v1 §5 契约)
  App.tsx                   装 <canvas> + JavisPulse;voiceStatus→setPhase;音频属性→pushSignals
  prototype/javis-pulse-v1.html   原型(参考,已收录)
```

WS 路径(`volc-asr`/`volc-tts`/`pipeline` 桩)**封存**:火山 RTC 模式不需要(火山管 ASR/TTS)。需自控音频时再启。

---

## 5. 记忆接口契约(替换当前扁平 MemoryStore)

```ts
// types.ts —— 三路径显式分离,身份为一等参数
type SpeakerId = string;            // = 火山 voiceprintId;'unknown' 保留
interface Turn { speaker: SpeakerId | 'agent'; text: string; ts: number }
interface ContextBundle {           // 热读产物,注入 prompt
  working: Turn[]; facts: Fact[]; preferences: Preference[]; persona: PersonaState;
}

// v2.1(team 评审后):身份证据层 + 事件溯源 + 两门面;详见 Javis-Memory-架构与逻辑.md
interface Identity {                // 火山身份归一 + 状态机(C1/C11)
  resolve(volcPayload): SpeakerEvidence;     // → ownerId(active_stable) | quarantine
}
interface Memory {                  // 对 custom-llm 只暴露两门面
  recall(q: { ownerId; query; working }): Promise<ContextBundle>;  // 热,≤50-80ms,hot cache 优先,无 LLM/无图;产物 data 化
  remember(t: { ownerId; confidence; utterance; sourceRole; asrConfidence; session }): Promise<void>; // 温,onDone后异步,幂等
}
interface Storage {                 // SQLite WAL,memory_item(typed) + status(committed|provisional|quarantine) + namespace/ACL + TTL,按 owner 分账
  /* typed_memory CRUD + view 隔离 + 快照 */
}
// ColdJob(夜间): MVP 只 TTL+去重+冲突 compaction+指标;反思/人格/压缩 暂缓
```
- **写时机/轮模型(C3)**:`remember` 只消费 EventLog 的 finalized user utterance;`source_role` 溯源(assistant 文本不作用户事实);被截断 response 标 aborted。
- **commit 不靠 reinforced≥N(C2)**:由 typed 生命周期(event/safety 一次直通 / preference 弱生效)驱动。
- **记忆作 data 不作 instruction(C4)**:ContextBundle 结构化渲染注入,不拼自然语言。
- 骨架阶段:`recall` 先 hot cache+关键词、`remember` 先确定性触发器;**契约就位**,逐组件填实现,调用方零改。

---

## 6. custom-llm 改造点(当前是无状态,要改)

1. **解析身份(C1)**:`Identity.resolve(火山payload)` → SpeakerEvidence 状态机 → `ownerId`(仅 active_stable)或 quarantine;无/不稳 → 只用 session/L0。
2. **会话态 + 事件溯源(C3)**:按 `roomId` 取/建 SessionState(L0 环形缓冲);写 EventLog(asr_segment/is_final/source_role/interrupted)。
3. **热读**:`memory.recall({ownerId, userText, working})` → ContextBundle → **data 化注入**(非自然语言拼接,C4)。
4. **写时机(C3)**:`memory.remember` 在 **`onDone` 后、从 EventLog 取 finalized user utterance**(非"完整(user,assistant)对");assistant 文本默认不作用户事实(C3/U1);幂等去重(U2)。
5. **身份门 + typed(C1/C2)**:非 active_stable/低置信 → 不写长期(只 L0);commit 由 typed 生命周期定,不靠 reinforced≥N。
6. **埋点 + memory-use 可观测(C21)**:每答记 身份/读了哪些/注入哪些/LLM 实际引用/降级原因/是否用 provisional。
7. `/api/rtc/stop` → session finalize。

---

## 7. 存储选型(设计 · v2.1)

- **SQLite + WAL**:单 `memory_item`(typed)表 + `status(committed|provisional|quarantine)` + `namespace`/`acl` + `ttl`,按 `owner_id` 分账;**view 隔离**(热路径只读 `hot_readable` view 不扫底表,C24)。
- **并发隔离(C8)**:热路径只读连接 + busy timeout 极低即降级;cold/hot 隔离 + per-owner read snapshot;实测 p95/p99 非均值。
- **向量按需后加**:MVP 先关键词/结构化单路检索;证明"查不准"再上 sqlite-vec(C5/C9)。LanceDB 仅规模指标证明必要时换。
- **不**用火山 VikingDB 作主存(护城河不外包);至多评测对照基线。

---

## 8. Phase 0(不做不开工 · PD §13)

地基三件,在写任何记忆层之前:
1. **延迟预算拆分埋点(C5)**:网络 RTT 单算 / **memory read p95≤50-80ms** / assembly≤20ms / LLM TTFT 单算。⚠️ 火山云→server RTT 不在我方控制,必须实测分离统计(别混进 200ms)。
2. **回放语料**:真实语音轮(含身份证据)落盘成可回放数据集。
3. **指标(C9/C10/C4 新增)**:p95/p99 tracing、memory precision/recall、**串账率**、**一次性关键事实保留率**、**prompt injection 抵抗率**、**纠正恢复时间**、memory-use 级可观测、矛盾率。这些指标也是后续层(向量/L2/人格)的**准入闸门**。

---

## 9. 当前骨架 → v2.1(MVP)差距与实施排序

MVP 范围见 [`Javis-Memory-架构与逻辑.md`](Javis-Memory-架构与逻辑.md) §15。逐层由指标 gate。

| 现状 | v2.1 MVP 目标 | 优先级 |
|---|---|---|
| 无埋点/回放/指标 | **Phase0 地基**:延迟拆分 telemetry + 回放语料 + 指标(串账率/一次性保留率/注入抵抗率)(§8) | **P0(不做不开工)** |
| `custom-llm` 无状态、写时机错、无身份 | §6 改造:身份证据层 + 事件溯源 + recall/remember 两门面 | P0 |
| `rtc.ts` 无声纹配置 | VoicePrint Mode=2 + Farfield + RegisterVoicePrint(§2.4) | P0 |
| `memory/types.ts` 扁平 recall+write | Memory/Identity/Storage 契约(§5)+ 身份证据状态机 | P0 |
| 无存储 | SQLite WAL + `memory_item`(typed) + view 隔离(§7) | P1 |
| 记忆原样拼 prompt | **记忆作 data 注入** + 注入测试集(C4) | P0(安全) |
| persona 是常量 | persona 为数据(简单可读偏好,**非自动 disposition**) | P2 |
| 无隐私治理 | 治理入口(查看/忘掉/重归属/暂停/导出)(C13) | P1 |
| `App.tsx` 占位 UI | 接入 JavisPulse 律动层(§11) | P1 |
| 三路召回/L2三元组/人格/反思/重 reconcile | **MVP 暂缓**,指标 gate 后再加 | ⬜ |
| WS 路径桩 | 封存 | — |

---

## 10. 决策与待办

1. **声纹方案**:已定(川哥 2026-06-29)默认 A(Mode=2),`voiceMode` 重连切 B。遗留待确认:≤3 人上限对家庭场景够不够。
2. **记忆 team 评审**:已完成(grok+codex,2026-06-30),转 MVP 减法,见 [`REVIEW`](REVIEW-memory-team-2026-06-30.md);记忆架构与逻辑已升 v2.0、PD 升 v1.1+§18。
3. **实施顺序(待川哥起跑)**:Phase0 地基 → 身份证据层+事件溯源 → 热路径读闭环(hot cache+单路检索+data化注入)→ 温路径(typed 生命周期)→ 冷路径(轻:TTL+去重+compaction)。逐层指标 gate。

---

## 11. 前端表现层(Javis Pulse · ④层)

> 规格 [`Javis-Pulse-前端律动可视化-v1.md`](Javis-Pulse-前端律动可视化-v1.md)(含 §13 火山集成附注);原型 `apps/web/prototype/javis-pulse-v1.html`。

**定位**:抽象发光律动球(非人脸),实时表现"在听/在想/在说"+ 声学能量。**纯前端、零素材、与后端/记忆完全解耦**——只消费 `phase` + 一路音频信号,不读写任何业务/记忆/声纹数据。

**与火山 RTC 的接线(全部火山原生,已验证):**

```
火山 RTC SDK ──┬─ 二进制 conv 消息 ──► voiceStatus(idle/listening/thinking/speaking) ─► pulse.setPhase()
               └─ enableAudioPropertiesReport(interval:100, enableSpectrum, enableVoicePitch)
                    ├─ onLocalAudioPropertiesReport  (listening 态 = 麦克风)  ─┐
                    └─ onRemoteAudioPropertiesReport (speaking 态 = bot TTS) ─┴─► pulse.pushSignals({volume,pitch,onset})
```

| pulse 输入 | 来源 | 映射 |
|---|---|---|
| `phase` | 火山 `conv` 状态(useVoiceRtc 已解析) | 直接 `setPhase`;thinking 态火山也给,仅需补视觉 |
| `volume` | `AudioPropertiesInfo.linearVolume` [0,255] | `/255` |
| `pitch` | `voicePitch`(直接基频)或 `spectrum`(谱质心) | 归一 0..1 |
| `rhythm` | volume 帧间上升沿 onset | pulse 内部算 |

**集成步骤**:① prototype HTML 抽成 `pulse/JavisPulse.ts`(前端 v1 §5 契约 mount/setPhase/pushSignals/setTheme/destroy);② `App.tsx` 放 `<canvas>` + 装组件;③ `voiceStatus` 变化 → `setPhase`;④ 开 `enableAudioPropertiesReport` → 按 phase 选 local/remote 报告 → `pushSignals`。**下游所有视觉反馈(胀大/变色/涟漪)已就绪,接上即用。**

**红线**:律动层不碰记忆/声纹/业务数据;声纹身份标签(`voiceprintName`)、字幕属并列的另一套 UI,与律动球同层、互不依赖。v1 不做人脸/lipsync(v2 可选,`docs/face.png` 方向:律动球作环绕能量场)。

**开放项(前端 v1 §12)**:thinking 态视觉、最终配色、phase 切换过渡缓动。
