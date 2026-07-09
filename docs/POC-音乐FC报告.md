# PoC 报告：意图路由 AI 化 M1 —— 音乐控制 Function Calling

> 依据 [`IMPL-音乐意图AI化-PROMPT.md`](../../../2-Projects/MyJavis/docs/IMPL-音乐意图AI化-PROMPT.md) 实施，本报告是 Gate 4 人工卡点产出。
> 工作区：`~/mycc/2-Projects/MyJavis-fc`（worktree，分支 `feat/music-intent-fc`）。**未 merge / 未 push / 未碰生产。**

## TL;DR

- **Gate 1**（provider 探测）：仅 DeepSeek(main) 流式 FC 可靠，MiniMax(fallback) 不可靠（撞词误触发 + 延迟超线）→ 按 §4.4「仅一家可靠」分支实施：带 tools 的轮次退化 DeepSeek 单路，不带 tools 的轮次维持原双路赛马。
- **Gate 2**（真实 /v1 + 真 DeepSeek 跑 §5.1 测试集）：真指令 **11/11** 正确、speakable_ms p95 **890ms**（达标）；撞词误触发 **2/10**（不达标，门槛是 0/10）。复测发现其中一条是**系统性**误判（7/7 复现），另一条是低概率采样噪音（1/7）。
- **Gate 3**（回归）：18 套测试（17 原有 + 1 新增）全绿、`pnpm build` 通过、`MUSIC_FC_ENABLED` off 回归确认现行为分毫不变。
- **结论**：架构可行、TTS 安全边界可靠、延迟可接受；**唯一未达标项是撞词误触发率**，且已定位到具体的、可复现的边界 case，不是随机噪音。是否接受这个已知边界上线，需川哥拍板（见「遗留问题」）。

---

## 1. 三个风险问题的数据答案（§2.3）

### Q1：DeepSeek / MiniMax 的流式 function calling 与现有赛马架构是否兼容？

**不完全兼容——但已按设计的降级分支妥善处理，不是推翻赛马架构。**

Gate 1 探测（14 条样本/家：撞词 6 + 指令 6 + 语义 2，工具定义用 §4.2 原文，真实请求）：

| Provider | 撞词+指令通过 | 关键问题 |
|---|---|---|
| DeepSeek(main) | **12/12** ✅ | 无；且每次真指令都是「先说话再调工具」（content 先于 tool_call） |
| MiniMax(fallback) | 11/12 ❌ | 撞词「别停，我听着呢」误触发 `resume`；reasoning 混进 `<think>` content（已知特性，生产侧 `createThinkStripper` 已兜底，不影响 TTS 安全但拖慢有效延迟）；**tool_call 延迟 1421–3487ms**，全部超过 1200ms 门槛（即使排除误触发那条，其余 11 条也没有一条达标） |

证据留档：[`docs/gate1-probe-evidence.md`](gate1-probe-evidence.md)（原始请求/响应片段）。

**实施结论（llm.ts）**：`args.tools?.length` 非空时，`fallbackEndpoint()` 直接不参与——带 tools 的轮次单路 DeepSeek，不赛马；不带 tools 的轮次（闲聊、无音乐会话）维持原有双路赛马，完全不受影响。赛马裁决规则本身也按设计扩展：首个 content delta 或首个 tool_call delta 都算「开口」可 claim（`providers/llm.ts` `streamOne`）。

### Q2：tool_call 能否 100% 拦在 TTS 之外？

**能，且是架构性保证。**

`streamOne` 里 `delta.tool_calls` 走完全独立于 `delta.content` 的代码路径——按 `index` 缓冲聚合 `arguments` 分片，从头到尾不经过 `sanitize`/`stripThink`/`onDelta` 这条 content 管线，物理上没有「泄漏」的代码路径可走。

验证方式两层：
1. **单元测试**（`music-fc.test.ts` 场景 1）：mock 一个真实 DeepSeek 响应形状（content 分片 + tool_calls 分片交错），逐块断言 `onDelta` 收到的每一片都不含 `tool_calls`/`"action"` 字样。
2. **真实调用**（Gate 1 + Gate 2 全部样本）：未观察到任何一次工具信息泄漏进可听内容。

### Q3：控制指令的可开口延迟是否可接受？

**可接受，但数字有一个测试条件需要说明。**

Gate 2 实测 `speakable_ms`（收到请求到首个可听输出）：

- p95 = **890ms**（门槛 ≤1200ms，达标）
- 全量样本范围 341–1031ms

**测试条件**：跑 Gate 2 时临时设 `FILLER_ENABLED=0`。原因：承接句（filler）默认同步直插（`waitMs=0`），会在 LLM 还没决策前就已经吐出「嗯/好的」——如果不关掉，测出来的「speakable_ms」测的是 filler 的速度而不是 FC 决策+执行的真实延迟，会让这个指标失去意义（永远接近 0ms）。所以 890ms 是**这条链路本身（不含 filler 兜底）的真实延迟**，是偏保守的数字——生产环境默认开 filler，用户实际体感的「开口」时间只会更短，不会更长。

---

## 2. 赛马策略结论

按 §4.4 三分支中的「**仅一家可靠**」分支实施：

- 带 tools 的轮次（房间有活跃音乐会话）→ 单路 DeepSeek(main)，不赛马。
- 不带 tools 的轮次（无音乐会话 / 音乐控制以外的普通对话）→ 维持原有双路赛马，完全不变。
- MiniMax(fallback) 不参与任何 FC 决策，但继续正常服务非 FC 轮次——这个改动的影响面严格限定在「有活跃音乐会话的轮次」，不影响其余场景的可用性冗余。

代码位置：[`apps/server/src/providers/llm.ts:293`](../apps/server/src/providers/llm.ts)（`const fb = args.tools?.length ? null : fallbackEndpoint();`）。

---

## 3. 达标情况（§5.2 门槛核对）

| 指标 | 门槛 | 实测 | 达标 |
|---|---|---|---|
| 撞词误触发 | 0/10 | 2/10（首轮单次采样） | ❌ **不达标** |
| 真指令正确率 | ≥9/10 | 11/11 | ✅ 达标 |
| speakable_ms p95 | ≤1200ms | 890ms | ✅ 达标 |
| 既有测试全绿 | 17 套 | 18/18（17 原有 + 1 新增 `test:music-fc`） | ✅ 达标 |
| `MUSIC_FC_ENABLED` off 回归 | 现行为分毫不变 | `music.test` 全绿 + 手工两条撞词验证一致 | ✅ 达标 |

**4/5 达标，撞词误触发是唯一不达标项**，且门槛本身是最严格的「一条误触发即不达标」。详细数据：[`docs/gate2-results.tsv`](gate2-results.tsv)。

### 撞词误触发复测（排除采样噪音干扰）

DeepSeek 默认 `temperature=1.0`（生产真实配置，非测试artifact），单次采样可能有随机性，因此对两条失败 case 各追加 6 次独立房间复测：

| Case | 首轮 | 复测(n=6) | 合计 | 判定 |
|---|---|---|---|---|
| "你说话大声一点" | 误触发 `louder` | **6/6 全部误触发** | **7/7（100%）** | **系统性误判**，非噪音 |
| "别停，我听着呢" | 误触发 `resume` | 0/6 误触发 | 1/7（≈14%） | 大概率是采样噪音 |

**根因假设**（推论，未验证）：「你说话大声一点」这句话本身语义天然双关——既可读作「请你（助手）说话声音大一点」，也可读作「把音乐声音调大」，且句子本身不含任何"音乐/歌/播放"类锚定词。§4.2 的工具描述里只给了"换一个话题""停一下我想想"两个反例，没有覆盖"对助手说话音量的请求"这一类，DeepSeek 在真实生产 persona prompt 下稳定地选择了"调音乐音量"这个解读。这是工具描述边界覆盖不足导致的可复现问题，不是模型能力随机波动。

**次要观察**：Gate 1（用极简探测 prompt）里这两条 DeepSeek 都答对；换成 Gate 2 的真实生产 system prompt（`assemblePrompt` 输出，含 TTS 输出规范等约十行规则）后才出现误判。说明**孤立探测工具本身的可靠性 ≠ 接入真实系统提示词后的可靠性**——这正是做 Gate 2（而不是只做 Gate 1 就下结论）的价值所在。

### 语义增强样本表现（不设硬门槛，观察性数据）

这组样本是 §2.2 提出的核心价值主张——「正则永远做不到的语义」：

| Case | 实际 action | 评价 |
|---|---|---|
| 这歌太吵了 | `quieter` | ✅ 合理 |
| 换个安静点的 | `pause` | ⚠️ 可接受但不算最贴切（更像"换一首"而非"暂停"，工具集里没有"换风格"这个动作，LLM 退而求其次） |
| 声音有点小听不清 | `louder` | ✅ 合理 |
| 别放这首了 | `next` | ✅ 合理 |
| 就这首挺好别换 | 无调用，纯聊天"行，那就继续放着。" | ✅ 正确识别为「不需要动作」 |

5 条里 4 条给出合理响应、1 条方向可接受但不精确、0 条误判成危险/破坏性动作。这些全部是现有正则**完全无法处理**（会直接落空为无响应闲聊）的语句，FC 路径至少让系统「有反应」——即使不是每次都最优解，也印证了 §2.2 的核心假设：语义裁决能接住正则的天花板。

---

## 4. 建议

1. **「你说话大声一点」类误判是否接受上线**：设计已定稿不可改（§4.2/§4.3 原文照做），本 PoC 未做任何 prompt/工具描述的调整尝试。建议留到下一轮迭代评估——可选方向：工具 description 或 contextNote 里补一条"用户要求'你'（助手）说话声音大小，不要调用"的反例；或者产品上直接接受这个已知边界（后果轻：最多是被误开大音量，用户一句"关小点"就能纠正，非破坏性、非不可逆）。
2. **speakable_ms 890ms 的测试条件差异**：如果这个数字要进最终验收材料，需要注明是 `FILLER_ENABLED=0` 下测的；生产默认开 filler，实际体感应更快，不需要额外担心。
3. **重复采样方法论**：本次对 2 条失败 case 做了 n=6 复测，证明了单次采样在 temperature=1.0 下确实会产生方差（"别停，我听着呢"从"看起来失败"变成"大概率噪音"）。若要把 Gate 2 的结论当作更有把握的验收依据，建议后续对全部 26 条至少补 n=3 复测，而不是依赖单次采样。

### 点歌域（第二片）可行性预判

M1 只覆盖控制域（6 个动作，闭集枚举）。点歌域（play/play_generic）复杂度显著更高，理由：

1. **参数空间从闭集变自由文本**：控制域 LLM 只要在 6 选项里选 1 个，语义空间小；点歌需要 LLM 从口语里准确提取干净的搜索 query（现有正则 `music-intent.ts` 为此打了大量真机踩坑补丁——"我想听听周杰伦的歌"要提取出"周杰伦"而不是"听周杰伦"这种字面陷阱），交给 LLM 做自由文本参数提取，正确率与鲁棒性目前完全未知，需要专门一轮 Gate1 式探测才能回答。
2. **ambiguous 候选反问是多轮状态机**：点歌命中多个候选时会进入"存候选 + 等用户下一句选择"的等待态（`resolveChoiceReply`），这与 FC「单轮闭环、零二轮调用」的延迟假设有天然张力——工具设计需要额外决定「返回候选列表让用户选」还是「LLM 自己挑一个最可能的直接播」，复杂度不是控制域的线性放大。
3. **本 PoC 的实测教训**：即便是最简单的 6 选 1 闭集枚举，DeepSeek 接入真实生产 prompt 后仍出现了系统性误判（100% 复现率）。参数空间更大、语义更开放的点歌域，先验上误判率大概率更高，不应该复用 M1「直接实施 + 单轮 Gate2」的验证节奏。

**预判**：值得做（能处理"来点适合睡觉的歌"这类正则永远做不到的语义化点歌），但下一片必须先补一轮 Gate1 式的自由文本 query 提取准确率探测（建议 ≥15 条覆盖真机踩坑过的陷阱句式），并在设计阶段先定夺 ambiguous 候选反问在 FC 下的产品形态，再决定是否实施。

---

## 5. 遗留问题

1. **「你说话大声一点」100% 误触发是否接受为已知边界上线** —— 需川哥拍板，见「建议」§1。
2. **DeepSeek 单路故障时的降级路径未设计**：FC 开启后控制类正则已完全让位（`resolveMusicCanned` 里 `if (config.music.fcEnabled) return null`），如果 DeepSeek 主路请求失败（限流/服务不可用），`streamChat` 的 `onError` 会走现有兜底文案（"（助手暂时连不上大脑）"），但**不会**退回到旧正则直接执行控制指令——FC 开启时旧正则路径对控制类完全不再触达。是否需要给 FC 轮次单独设计"主路失败时退回正则兜底执行"的降级链，本 PoC 未覆盖，建议全量上线前评估。
3. **点歌域可行性预判是纯理论推演**：见"建议"章节，未做任何代码或探测验证。
4. **未做并发压测**：本 PoC 只验证了单会话/单房间场景，多个用户同时触发 FC 控制词时 DeepSeek 单路是否有速率限制风险，未测试。

---

## 6. 产物清单

### 代码改动（6 文件，`git diff --stat`）

```
apps/server/package.json                       |   1 +   （新增 test:music-fc 脚本）
apps/server/src/config.ts                       |   2 +   （MUSIC_FC_ENABLED 开关）
apps/server/src/music/orchestrator-client.ts    |  24 +++（测试 stub 开关，仅影响 musicPlay/musicPlayById）
apps/server/src/providers/llm.ts                |  57 ++-（流式 tool_calls 缓冲聚合 + 赛马降级策略）
apps/server/src/providers/types.ts              |  14 +   （LlmToolDef / tools / onToolCall 类型）
apps/server/src/routes/custom-llm.ts            | 128 ++-（FC 路由主逻辑：control 正则让位 + 工具/contextNote 注入 + onToolCall 执行副作用）
```

### 新增文件

- `apps/server/scripts/gate1-probe.ts` —— Gate 1 探测脚本（可重跑）
- `apps/server/scripts/gate2-eval.ts` —— Gate 2 数据脚本（可重跑，用法见文件头注释）
- `apps/server/scripts/music-fc.test.ts` —— FC 单测（`pnpm run test:music-fc`，纯逻辑 + mock fetch，不出网）
- `docs/gate1-probe-evidence.md` —— Gate 1 原始请求/响应片段留档
- `docs/gate2-results.tsv` —— Gate 2 完整测试集结果

### 验证记录

- 18 套 `test:*` 全绿（含新增 `test:music-fc`）
- `pnpm build`（server + web）通过
- `MUSIC_FC_ENABLED` off 手工回归：`我们换一个话题` 走正常 LLM 聊天（未触发控制）；`换一首` 走旧版正则直出 canned（非 LLM 流，服务端日志零 `[music-fc]` 输出）——与补丁前行为一致

---

**PoC 到此停在 Gate 4。禁止 merge / push 远端 / 连生产 / 发版 / 改主仓。等待川哥和 cc 验收。**

署名：cc（Claude）| 2026-07-09
