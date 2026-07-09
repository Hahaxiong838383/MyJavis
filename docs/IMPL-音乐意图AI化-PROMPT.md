# 实施任务：意图路由 AI 化 M1 —— 音乐控制 Function Calling PoC

> 你是本任务的执行工程师。本文档自包含：读完即可动手，不需要翻阅对话历史。
> **设计已由川哥拍板 + cc 定稿——按本文档实施，不要重新设计。** 有实施层疑问在 PoC 报告中列出，不要自行扩大范围。
> 完成后停在 Gate 4 人工卡点：**禁止 merge / 禁止 push 到远端 / 禁止接触生产服务器 / 禁止发版。**

---

## 0. 工作区声明（先做这个）

```bash
cd ~/mycc/2-Projects/MyJavis
git worktree add ../MyJavis-fc -b feat/music-intent-fc
cd ../MyJavis-fc
cp ~/mycc/2-Projects/MyJavis/.env .env   # LLM key（gitignored，PoC 要真调两家 provider）
pnpm install
```

- **一切工作只在 `~/mycc/2-Projects/MyJavis-fc`（worktree）内进行**；主仓 `~/mycc/2-Projects/MyJavis` 绝对不碰。
- 本地起服务端口段 **3390-3399**（server 用 `PORT=3390`），不占别的端口。
- **生产服务器 root@47.239.204.68 绝对不连、不部署。** 一切验证在本机。
- worktree 内不修改 `0-System/**`、`CLAUDE.md`、`.claude/**`。

## 1. 项目铁律（违反任何一条=返工）

1. 所有回复和代码注释用中文。
2. **不碰的域**：提醒时间解析（`reminder/` 确定性规则，川哥红线）、声纹注册/删除状态机（`voiceprint/enroll-session.ts` / `forget-session.ts`）、记忆系统（`memory/`）。本任务只动音乐意图路由。
3. `/v1` 的 SSE 输出直接进火山 TTS 变语音——**任何非用户可听文本（JSON、tool_call 片段、调试信息）绝不能进 content 流**。
4. 意图判定原则「宁漏勿误」：不确定时宁可当闲聊，绝不误执行。
5. 现有 17 套测试（`package.json` 的 `test:*`）全绿是底线，不许修改既有测试来迁就新代码（除非测试本身与新开关行为冲突，需在报告中说明）。
6. 本地 E2E 调 `/v1` 时必带 `Authorization: Bearer $CUSTOM_LLM_API_KEY`（.env 里有；踩过三次的坑）。
7. 测试中**不许真调 B 站/音乐 orchestrator 搜索**——音乐副作用要 stub（见 §4.4）。

## 2. 背景与目标（为什么做）

### 2.1 撞词问题史（根因）

音乐意图现为正则匹配 + canned 直出（跳过 LLM）。2026-07-08 川哥真机连环踩坑：
- 「我们换一个话题」被 `NEXT_RE` 的「换一个」命中 → 回「现在还没在放歌呢」
- 已打补丁：删过泛词（换一个/换一换/上一个）+ 控制类加播放状态门控（无音乐会话 → return null 走闲聊）

补丁治标：正则永远理解不了上下文（「停一下我想想」vs「停一下音乐」），每个补丁都在为下一个漏洞埋伏笔。

### 2.2 拍板的终局方案（M1 = 第一片 PoC）

**音乐控制意图从正则迁到主对话 LLM 的 function calling**：
- 播放状态注入上下文，LLM 生成回复的同一次调用里自然完成语义裁决（**零额外 LLM 调用**，这是与「前置分类器」路线的本质区别——语音链路加不起串行延迟）
- 「换一个话题」LLM 懂是聊天；「换一首」LLM 懂是切歌；「这歌太吵了」这类正则永远做不到的语义也能接住

**PoC 目的是拿数据回答三个风险问题**（不是全量上线）：
1. DeepSeek / MiniMax 的**流式 function calling** 与现有赛马架构是否兼容？
2. tool_call 能否 100% 拦在 TTS 之外？
3. 控制指令的可开口延迟是否可接受（基线：canned <50ms、闲聊 TTFT ~550ms）？

### 2.3 PoC 范围（明确圈定，禁扩展）

| 域 | 处理 |
|---|---|
| 音乐**控制**类 6 动作（pause/resume/next/prev/louder/quieter） | ✅ 迁 FC（本任务全部内容） |
| 点歌类（play/play_generic）+ 选歌等待态（awaiting-choice） | ❌ 保留现有正则/状态机，原样不动 |
| 提醒 / 声纹 / 记忆 | ❌ 铁律不碰 |

## 3. 代码地图（改哪里）

| 文件 | 现状 | 本任务动作 |
|---|---|---|
| `apps/server/src/providers/llm.ts`（303 行） | 双 provider 赛马：`streamChat(args)`，`onDelta(visible)`/`onDone(full)`，首个可见 token `claim()` 胜出、败者 abort（269-276 行） | 扩展支持 tools：请求带 `tools` 数组；delta 里的 `tool_calls` 缓冲聚合，**不经 onDelta 外漏**；新增 `onToolCall(name, args)` 回调；赛马裁决兼容「首个 tool_call delta 也算开口」 |
| `apps/server/src/routes/custom-llm.ts` | `resolveMusicCanned`（~851 行）：awaiting-choice → 意图正则 → play/control 分支；control 已有音乐会话门控；`llm.streamChat` 调用在 ~355 行 | FC 开启且房间有音乐会话时：控制类正则跳过、请求带 music_control 工具 + 播放状态 contextNote；`onToolCall` 里执行现有副作用（换歌/`setPending`）并输出 ack |
| `apps/server/src/music/music-intent.ts` | 控制/点歌正则（已收紧） | FC 路径下控制正则不再使用（保留代码，off 时回退用） |
| `apps/server/src/music/music-session.ts` | `getMusicSession(roomId)`：放过歌才有；`lastQuery`/`playedIds`/历史栈 | 只读引用：tools 注入条件 + 播放状态文案 |
| `apps/server/scripts/music.test.ts` | 意图正则单测（含撞词反例） | 保持全绿；新增 FC 相关测试另建文件 |

关键现有逻辑（复用，别重写）：`resolveMusicCanned` 的 control 分支里 next（用 lastQuery 重搜+排除已放）、prev（`takePrevTrack` 历史栈）、pause/resume/louder/quieter（`setPending(roomId, {action:'control', control})` + 固定 ack 文案）。

## 4. 实施设计（已定稿，照做）

### 4.1 开关与路由

- 新增 env `MUSIC_FC_ENABLED`（默认 **false**）。off = 现行为分毫不变（回退保障）；on = 以下 FC 路径。
- FC on 时每轮判定：`getMusicSession(roomId)` 存在（放过歌）→ 本轮请求注入 tools + 播放状态上下文，且 **控制类正则跳过**（语义裁决全权交 LLM）；无音乐会话 → 不带 tools，控制类正则也跳过（与现门控行为一致：闲聊）。
- 点歌正则、awaiting-choice 状态机在两种模式下都保留且**先于** FC 判定执行（正在选歌的轮次不进 FC）。

### 4.2 工具定义（单工具，参数走 enum）

```json
{
  "type": "function",
  "function": {
    "name": "music_control",
    "description": "控制正在播放的音乐。仅当用户明确想操作音乐播放时调用；聊天中提到相关字眼（如'换一个话题''停一下我想想'）不要调用。",
    "parameters": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": ["pause", "resume", "next", "prev", "louder", "quieter"],
          "description": "pause=暂停 resume=继续播 next=换一首/下一首 prev=上一首 louder=大声点 quieter=小声点"
        }
      },
      "required": ["action"]
    }
  }
}
```

播放状态 contextNote（拼进现有 contextNote 链，格式沿用现有 `[系统…]` 风格）：
`[系统状态] 当前房间正在播放音乐：《{title}》。用户若想暂停/继续/换歌/调音量，调用 music_control；普通聊天正常回复，别把聊天字眼当指令。`

### 4.3 流式 tool_call 处理（TTS 安全是红线）

- provider 返回的 `choices[0].delta.tool_calls` 片段：**缓冲聚合**（按 index 拼 arguments），绝不进 content 流。
- tool_call 完整（finish_reason=tool_calls 或流结束）→ 触发 `onToolCall(name, argsJson)`：
  - custom-llm 层执行副作用（完全复用现有 control 分支逻辑）
  - **ack 文案**：若 LLM 本轮同时输出了 content（先说话后调工具），用 LLM 的话；没有 content 则输出现有固定 ack（「好嘞，暂停。」等）——**不做二轮 LLM 调用**（保延迟）
- action 值不在 enum 内 / JSON 解析失败 → 忽略工具调用，当纯闲聊处理（宁漏勿误），记日志。

### 4.4 赛马兼容策略（Gate 1 探测决定）

先各自单独实测 DeepSeek（main）与 MiniMax（fallback）的**流式 FC**（带上面工具定义真发请求，含撞词和真指令各 2-3 条）：
- **两家都可靠** → 双路赛马都带 tools；裁决规则扩展：首个 content delta **或** 首个 tool_call delta 都算「开口」可 claim
- **仅一家可靠** → tools 轮退化为该家单路（不赛马；语义裁决一致性优先于可用性冗余），无 tools 轮维持双路赛马
- **两家都不行** → PoC 终止，写报告（这本身就是有效结论）

「可靠」标准：流式 FC 语法正确 + 撞词不误调 + 真指令正确调（探测样本 ≥5 条/家）。

音乐副作用 stub：测试时不真调 orchestrator——看 `music.test.ts` / orchestrator-client 现状选择 stub 方式（env 开关或注入），确保测试只验证「意图→工具调用→副作用函数被调」链路，不出网。

### 4.5 观测

- 沿用 `[custom-llm]` 日志风格，FC 轮打：`[music-fc] session=X tool=music_control action=pause speakable_ms=NNN`
- `speakable_ms` = 收到请求到首个可听输出（content 首 delta 或 ack enqueue）的耗时——这是 PoC 核心指标。

## 5. 测试与数据（Gate 2 的产物）

### 5.1 意图测试集（写成脚本可重跑，结果落 TSV）

三组，走**真实 /v1 HTTP + 真 provider**（这是 PoC 本体——测的就是真模型行为）：

- **撞词反例 ≥10**（有音乐会话状态下发送，期望：不调用工具，正常闲聊）：我们换一个话题 / 停一下我想想 / 你说话大声一点 / 上一个问题你还没答 / 继续说啊 / 别停，我听着呢（这条期望聊天！）/ 把灯关了 / 这个方案先暂停推进 / 换个说法 / 声音这个词怎么写
- **真指令 ≥10**（同状态，期望：正确 action）：暂停 / 停止播放 / 别放了 / 换一首 / 下一首 / 切歌 / 继续播 / 接着放 / 大声点 / 小声一点 / 上一首
- **语义增强 ≥5**（正则永远做不到的，记录表现不设硬门槛）：这歌太吵了 / 换个安静点的 / 声音有点小听不清 / 别放这首了 / 就这首挺好别换

TSV 列：`case  期望  provider  实际action  是否调用工具  speakable_ms  回复文本首30字`。

### 5.2 验收门槛

| 指标 | 门槛 |
|---|---|
| 撞词误触发 | **0 / 10**（一条误触发即不达标） |
| 真指令正确率 | ≥ 9/10 |
| speakable_ms p95 | ≤ 1200ms（超过=语音场景不适用，如实报） |
| 既有 17 套测试 | 全绿 |
| `MUSIC_FC_ENABLED` off 回归 | 现行为分毫不变（music.test 全绿 + 手工两条撞词验证） |

## 6. 验收流程（四道门）

- **Gate 1 探测**：两家 provider 流式 FC 兼容性报告（原始请求/响应片段留档）→ 决定赛马策略（§4.4 三分支）
- **Gate 2 数据**：§5 测试集跑批 TSV + 指标对照门槛
- **Gate 3 回归**：17 套测试全绿、`pnpm build`（server+web）过、off 开关回归验证
- **Gate 4 人工卡点（停在这）**：输出 **PoC 报告**（`docs/POC-音乐FC报告.md`）：三个风险问题的数据答案 + 赛马策略结论 + 达标情况 + 全量化建议（含点歌域第二片的可行性预判）+ 遗留问题。**然后停下等川哥和 cc 验收。禁止 merge / push / 碰生产 / 发版。**

## 7. 明令禁止

- 禁改提醒/声纹/记忆域的任何代码
- 禁动点歌正则与 awaiting-choice 状态机的行为
- 禁在 FC 路径做二轮 LLM 调用（延迟红线）
- 禁把任何非人话内容送进 /v1 content 流
- 禁真调 B 站/orchestrator 搜索（测试必须 stub）
- 禁 merge / push 远端 / 连生产 / 发版 / 改主仓
- 禁自行扩大范围（发现的好想法写进报告的「建议」节）
