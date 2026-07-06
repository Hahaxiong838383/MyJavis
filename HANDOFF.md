# MyJavis — 进展与后续计划(HANDOFF)

> 更新:2026-07-06(cc)。接手先读本文件 → `docs/PRODUCT-DEFINITION.md`(总纲)→ memory `project_myjavis`(最全)。
> 一句话:个人 Jarvis 式实时语音助手(火山 RTC 全双工 + 声纹认人 + 分人记忆 + 律动球),**已进入 ≤10 人邀请制内测阶段**。
>
> **仓库**:独立私有仓 `github.com/Hahaxiong838383/MyJavis`(2026-07-03 从 oh-my-ccwork subtree split 独立,commit/push 在本目录,不进 monorepo)。
>
> **当前版本 v0.8.2**。核心已全通:声纹注册(说"我是X,记住我的声音"零UI)+识别认人+记忆分账;多租户(邀请码 jv-xxxxx-xxxxx,每人独立声纹/记忆/人设/称呼);分发(DMG https://javis.chenchuan.cc/updates/ + 激活页 + tauri updater 自动更新,双向实证)。发版=`scripts/release-app.sh "说明"` 一条命令(自动摘 admin key+minisign 签名+上传)。
> 拓扑:App→javis.chenchuan.cc(47.239 HK);火山回调→kidshub-ai.hahaxiong.cc/myjavis/(8.218 中转)→47.239。LLM=DeepSeek/MiniMax 赛马;判停 300ms+AIVAD+Prefill;承接句 5 桶直插。
> ⚠️ updater 私钥 `~/.tauri/myjavis-updater.key` 丢失=无法再推更新(待备份密码管理器)。

---

## 1. 当前状态总览

| 层 | 状态 | 说明 |
|---|---|---|
| ① 语音 I/O(火山 RTC) | 🟢 骨架可跑 | RTC CustomLLM 路径 E2E 验证过(server boot/health/SSE 真实 LLM 外呼) |
| ② 身份(火山声纹) | 🟡 设计定档+配置占位 | 默认 A=Mode2 识别(≤3人)+ B=Mode1 降噪兜底(voiceMode 重连切);`rtc.ts` 声纹配置已加(VoicePrint/FarfieldConfig);**payload 仍 mockIdentityPayload,待接真** |
| ③ 记忆护城河 | 🟢 MVP 已实现 | 批次1+2 落 main:身份证据层状态机/事件溯源/typed 生命周期/确定性 admit/冲突收敛/显式纠正;测试全绿,Phase0 eval 16 样本红线指标全达标 |
| ④ 前端律动+治理(Javis Pulse) | 🟢 组件已落 | `PulseOrb.tsx`(forwardRef 暴露 pushSignals)+`GovernancePanel.tsx`+治理 API(ownerId ACL);音频信号仍本地麦克风占位,待接火山音频属性报告 |
| macOS 壳(Tauri) | 🟢 已落+真机验通 | `apps/web/src-tauri/` Tauri v2 薄壳,`pnpm tauri:build` 产 MyJavis.app(9.68MB arm64);WKWebView getUserMedia 命门川哥真机验通过;图标已配 |

---

## 2. 已完成

**代码骨架(可 `pnpm install` 跑)**:
- 火山 RTC 路径:`apps/server/src/`(index/routes/rtc/routes/custom-llm/providers/llm/rtc-token.cjs/rtc-prompt-override)+ `apps/web/`(useVoiceRtc + UI)。
- 验证:server+web `tsc` 零错;`/health` ok;`/api/rtc/start` 缺凭证优雅报错;`/v1/chat/completions` 合规 OpenAI SSE(真实 LLM 外呼,仅受网关账号策略限未跑通 happy-path)。

**实施批次(Codex 实施 + cc 独立验证后合 main,2026-06-30)**:
- **批次1 地基**(PR#15):SQLite WAL schema(memory_item/speaker_evidence/owner/pref_summary/audit/event_log + hot_readable/quarantined 视图)+ 身份证据层状态机(unverified→registering→active_low→active_stable,仅 active_stable 出 memory_owner_id)+ 事件溯源(append-only,只从 finalized user utterance 抽取)+ Memory.recall/remember 与 Identity.resolve 门面 + 结构化 data 注入(防 prompt injection)+ telemetry 按轮 NDJSON + Phase0 回放 eval。详见 `docs/IMPL-地基-进展.md`。
- **批次2 温路径智能**(PR#15):显式触发器(闲聊不进长期)+ 确定性 admit(salience+novelty+conflict,LLM 仅 stub)+ typed 生命周期(**event/safety 一次直通 committed=评审 C2 核心修复**,preference 先 provisional)+ pref_summary 冲突收敛(同 dimension 上限5)+ 显式纠正(delete/update/reattribute/lower_confidence,跨 owner 拒)。详见 `docs/IMPL-记忆智能-进展.md`。
- **批次3 治理+律动球**(PR#16):治理 API(list-by-owner/suspend/resume/delete/reassign/export,全走 ownerId ACL)+ suspended 列(hot 视图排除)+ `PulseOrb.tsx` React 律动球 + `GovernancePanel.tsx` 最小面板。
- **批次4 Tauri 薄壳**(PR#17)+ 图标(PR#18):`apps/web/src-tauri/` 不改业务码;WKWebView getUserMedia 真机验通过(火山 Web RTC SDK 在壳内能拿音频流);icon.icns 全套。
- **验证口径**:治理/storage/identity/candidates/lifecycle/conflict/correction/prompt-injection 测试全绿;eval 16 样本:串账率 0/一次性保留率 1/注入抵抗率 1/owner 泄漏 0(延迟字段仍脚手架)。

**设计文档(已收敛)**:
- `docs/PRODUCT-DEFINITION.md` v1.1 — 总纲(产品目标 G1-G5 + 四层架构图)
- `docs/Javis-Memory-产品定义-完整版.md` v1.1+§18 — 记忆产品定义(川哥写,§18=team 评审后修订)
- `docs/Javis-Memory-架构与逻辑.md` v2.0 — 记忆实现蓝本(身份证据层/事件溯源/typed 生命周期/memory-as-data/MVP)
- `docs/Javis-Pulse-前端律动可视化-v1.md` — 前端律动规格(+§13 火山集成)
- `docs/ARCHITECTURE-v2.md` v2.1 — 系统实现架构
- `docs/REVIEW-memory-team-2026-06-30.md` — team 对抗评审(grok+codex)综合 + cc 裁决
- `docs/IMPL-地基-进展.md` / `docs/IMPL-记忆智能-进展.md` — 批次1/2 实施进展
- `04-决策记录.md` — 全程决策链

**关键决策**(详见 `04-决策记录.md`):火山 RTC 模式为主 / 声纹默认 A 兜底 B / 记忆 MVP 减法 / 提交边界折中(留边界砍引擎) / 护城河重定义 / 设备形态=Tauri 薄壳+Web 核心复用(否决 Electron/原生 Swift)。

---

## 3. 后续计划(按优先级,逐层指标 gate)

**P0 — 打通真实链路**:
1. ~~LLM 选型 + 凭据~~ ✅ **2026-07-02 全部完成**:
   - LLM=deepseek-v4-flash(实测可开口 TTFT 中位 2372ms vs MiniMax-M2.7-highspeed 2890ms,后者 `<think>` 混 content 且 `thinking:{type:"disabled"}` 被静默忽略,语音场景不可用)。
   - `.env` 全齐:RTC AppId/AppKey + ASR/TTS(APP 7699738941) + DeepSeek + **OpenAPI AK/SK**(源:~/Documents/陈川个人站/火山 access key.rtf)。
   - **验证全绿**:custom-llm `/v1/chat/completions` 真实 DeepSeek SSE happy-path(含 SQLiteMemoryStore+身份链路)+ `/api/rtc/start` **StartVoiceChat 真通**(房间/token/taskId,voiceMode=identify)+ `/api/rtc/stop` StopVoiceChat 火山确认 ok。
   - ~~CUSTOM_LLM_URL 公网~~ ✅ **2026-07-02 已部署生产**(详见下方"部署拓扑")。
2. ~~公网部署~~ ✅ **2026-07-02 完成,E2E 全绿**:
   - **部署拓扑**:aliyun-kr(个人站 VPS,韩国首尔)`/opt/myjavis/`(dist+node_modules+.env 600)+ pm2 `myjavis-server`(:3001,cwd=/opt/myjavis,--env-file)+ nginx `location ^~ /myjavis/` 反代(SSE:buffering off,conf 备份 .bak-cc-20260702)。`CUSTOM_LLM_URL=https://my.chenchuan.cc/myjavis/v1/chat/completions` + `CUSTOM_LLM_API_KEY` 回调鉴权已设(无 key 401)。本地/VPS 双侧 .env 已同步。
   - **TTFT 优化**:llm.ts 加 `thinking:{type:"disabled"}`(env `LLM_DISABLE_THINKING` 可关)——DeepSeek 实测生效,走完整链路(身份+记忆+组装)可开口 TTFT 中位 **660ms**(优化前裸连 2372ms,砍 72%),kidshub 先例印证。
   - **公网 E2E 全绿**:health ok / 无 key 401 / 带 key SSE 真实 DeepSeek 流 / StartVoiceChat+StopVoiceChat 双向 ok(回调地址真实可达)。
   - **RTT 实测**(Phase0 风险项关闭):VPS→rtc.volcengineapi.com connect 101ms / →openspeech 52ms,在预算内;精确 networkRttMs 等真人对话 telemetry。
   - **部署坑**:`rtc-token.cjs` 是 CJS 不被 tsc 编译,dist 缺它启动崩(本地 tsx 跑 src 不暴露)——build script 已固化 `&& cp src/rtc-token.cjs dist/`。
   - **发版 SOP**:本地 `pnpm --filter @myjavis/server build` → `rsync -az --delete apps/server/dist/ aliyun-kr:/opt/myjavis/dist/` → (依赖变了才)rsync package.json+npm install → `ssh aliyun-kr 'pm2 restart myjavis-server'` → 公网 curl health+SSE 验证。
3. ~~前端对接~~ ✅ **2026-07-02 打通(commit 856cbace5)**:
   - **api.ts 统一入口**:`VITE_API_BASE`(空=同源 dev proxy;生产=`https://my.chenchuan.cc/myjavis`)+`VITE_JAVIS_API_KEY`(自动带 `X-Javis-Key` header);useVoiceRtc/GovernancePanel 全改走 apiFetch。web 侧配置在 `apps/web/.env.local`(gitignore)。
   - **server 安全收口**:公网 /api/* 原裸奔(任何人可拉房间烧火山钱/读记忆)→ 加 CORS(origin \*,CORS 非安全边界)+ `JAVIS_API_KEY` 鉴权中间件(无 key 401;/v1 有自己的 CUSTOM_LLM_API_KEY 门;本地 dev 不设不拦)。双侧 .env 已同步已部署。
   - **preview 实证下行全链路**:进房 → bot welcome「你好川哥，我是 Javis，随时吩咐。」字幕流式上屏(subv 增量5包)+ conv answering→answerFinish + 状态「在听…」;网络面板 CORS 204/start 200/governance 200 全绿。麦克风 NotAllowedError 为无头浏览器限制,非缺陷。
   - **MyJavis.app 公网版已打包**(9.9MB):`apps/web/src-tauri/target/release/bundle/macos/MyJavis.app`,公网 base 已验编入 bundle。**待川哥双击真机开麦说第一句话(上行 ASR→记忆→DeepSeek→TTS 唯一未实证段)**。
   - vite 加 `VITE_NO_HTTPS=1` 开关(P003 同款,preview/无头用;localhost 本身 secure context)。
2. 接真实火山声纹 payload 替换 `mockIdentityPayload`(字幕 voiceprintId → SpeakerEvidence),补契约回放测试。
3. 声纹注册流(RegisterVoicePrint OpenAPI)。
4. 真人语音 E2E:Tauri 壳内全双工对话 + 声纹真区分人 + 串账率真实测量。
5. 火山音频属性报告(enableAudioPropertiesReport:linearVolume/voicePitch/spectrum)接 PulseOrb `pushSignals`(现本地麦克风占位)。
6. 火山云→server RTT 实测(在 200ms 预算之外,风险项)+ 真实 telemetry p95/p99 汇总(eval 延迟字段仍脚手架)。

**P1 — 记忆智能补全**:
7. 高风险实体确认流:手机号/地址/健康/金额"确认后才 committed"+ 复述。
8. active_stable 判定阈值 + VoicePrint Score 策略参数化。
9. 真 hot cache + 关键词/结构化检索 + pref_summary 收敛真实现。
10. task/reminder 层 + calendar 解析(现 placeholder)。
11. 治理面板美化(功能 MVP 已通)。

**P2 — 工程尾巴**:
12. Tauri entitlements 真签名(开 App Sandbox/上架才需要;本地 TCC 够用)+ `time` crate 死 pin 升级 Tauri 时复查。

**MVP 暂缓(指标证明缺口再加)**:向量召回 / L2 通用三元组 / 人格 disposition / 反思内核 / 三路并行召回 / 重型夜间 reconcile。

---

## 4. 关键风险/遗留

- 声纹 ≤3 人上限对家庭场景是否够(超 3 人需兜底设计)——待川哥确认。
- 火山云→server RTT 在我方 200ms 预算之外,必实测(已列 P0-6)。
- 火山锁定:身份线绑火山,已设计 IdentityProviderAdapter 缓冲,但需契约测试(已列 P0-2)。
- `docs/face.png`=v2 点云脸方向(律动球作环绕能量场),暂不动。
- `docs/*.pdf`(火山官方文档 105MB)已 gitignore,不入仓;需要时本地放回。

---

## 5. 接手提示词(可直接粘贴)

```
读 ~/mycc/2-Projects/MyJavis/HANDOFF.md 和 docs/PRODUCT-DEFINITION.md(总纲)。
MyJavis 是火山 RTC 实时语音助手。记忆 MVP/治理/律动球/Tauri 壳已落 main(批次1-4,PR#15-18,见 docs/IMPL-*.md);
测试全绿、Phase0 回放 eval 红线指标达标(串账0/一次性保留1/注入抵抗1)。
当前卡真实火山凭据 + LLM 选型(config.ts llm 空占位,川哥拍板);拿到后按 HANDOFF §3 P0 顺序:
接真声纹 payload 替 mockIdentityPayload → RegisterVoicePrint 注册流 → Tauri 壳真人 E2E → 音频属性接 PulseOrb → RTT 实测。
记忆设计红线:身份门(仅 active_stable 写长期)/记忆作 data 不作 instruction/typed 生命周期(event/safety 一次直通);
另见 memory: project_myjavis + feedback_voice_agent_memory_design_traps。
```
