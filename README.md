# MyJavis — 个人实时语音助手（火山 RTC × 声纹 × 可控记忆 × 律动前端）

> 个人 Jarvis 式实时语音助手：随时对话、能打断、低延迟，**能区分不同说话人（声纹）**、具备**可控进化的长期记忆**，前端是一颗由语音实时驱动的发光律动球。
>
> 技术底座抽取自 P003「小可」生产代码（火山引擎 RTC 全链路，真机 E2E 验证），剥离儿童陪伴业务，重做成通用个人助手。

## 现状（2026-07-02）

**设计收敛 + 记忆 MVP/治理/律动球/Tauri 壳四批已落 main（PR#15-18）；当前卡在真实火山凭据 + LLM 选型，给了即可起跑真人 E2E。** 详见 [`HANDOFF`](HANDOFF.md)（本地）/ [`04-决策记录.md`](04-决策记录.md)。

| 层 | 状态 |
|---|---|
| ① 语音 I/O（火山 RTC 全双工/打断/ASR/TTS） | 🟢 骨架 E2E 跑通（server boot / health / SSE 真实 LLM 外呼） |
| ② 身份（火山声纹，区分说话人） | 🟡 设计定档 + `rtc.ts` 声纹配置占位（Mode2 识别≤3人 / Mode1 降噪 / FarfieldConfig）；**payload 仍 mock**，待接真 |
| ③ 记忆护城河（自建，本地 SQLite） | 🟢 MVP 已实现：身份证据层状态机 / 事件溯源 / typed 生命周期 / 确定性 admit / 冲突收敛 / 显式纠正，测试全绿（见 [`docs/IMPL-地基-进展.md`](docs/IMPL-地基-进展.md) + [`docs/IMPL-记忆智能-进展.md`](docs/IMPL-记忆智能-进展.md)） |
| ④ 前端律动 + 治理（Javis Pulse） | 🟢 `PulseOrb.tsx` React 组件 + `GovernancePanel.tsx` + 治理 API（suspend/delete/reassign/export，ownerId ACL）已落；音频信号仍本地麦克风占位，待接火山音频属性报告 |
| macOS 壳 | 🟢 Tauri 薄壳（9.68MB arm64）+ 图标；WKWebView getUserMedia 命门真机验通过 |

Phase0 回放评测 16 样本：串账率 0 / 一次性事实保留率 1 / 注入抵抗率 1 / owner 泄漏 0（延迟字段仍为脚手架，非真实测量）。

## 四层架构

```
④ 前端律动 Javis Pulse（纯前端·零素材·解耦）  消费 phase + 火山音频属性报告
─────────────────────────────────────────────────────────────────
① 语音 I/O  火山 RTC      ASR→TTS→全双工/打断/VAD，服务端只当 CustomLLM 大脑
② 身份      火山声纹       识别 Mode2(≤3人) / 降噪 Mode1 / 远场抑制 / 说话人验证
③ 记忆护城河 自建(MVP)     热(读≤80ms hot cache) / 温(写 typed 生命周期) / 冷(轻:TTL+去重)
─────────────────────────────────────────────────────────────────
火山 RTC = 语音 I/O + 声纹身份传感器（全配置化）  │  我方 = 记忆大脑 + 前端表现
```

## 文档（docs/）

| 文档 | 内容 |
|---|---|
| [`PRODUCT-DEFINITION.md`](docs/PRODUCT-DEFINITION.md) | **总纲**：产品目标 G1-G5 + 四层架构（先读这个） |
| [`Javis-Memory-产品定义-完整版.md`](docs/Javis-Memory-产品定义-完整版.md) | 记忆产品定义（§18 = team 评审后修订） |
| [`Javis-Memory-架构与逻辑.md`](docs/Javis-Memory-架构与逻辑.md) | 记忆实现蓝本 v2.0（身份证据层/事件溯源/typed 生命周期/memory-as-data/MVP） |
| [`Javis-Pulse-前端律动可视化-v1.md`](docs/Javis-Pulse-前端律动可视化-v1.md) | 前端律动规格（+§13 火山集成） |
| [`ARCHITECTURE-v2.md`](docs/ARCHITECTURE-v2.md) | 系统实现架构 v2.1 |
| [`REVIEW-memory-team-2026-06-30.md`](docs/REVIEW-memory-team-2026-06-30.md) | team 对抗评审（grok+codex）综合 + cc 裁决 |
| [`IMPL-地基-进展.md`](docs/IMPL-地基-进展.md) | 批次1 实施进展（SQLite schema/身份证据层/事件溯源/telemetry/Phase0 eval） |
| [`IMPL-记忆智能-进展.md`](docs/IMPL-记忆智能-进展.md) | 批次2 实施进展（触发器/admit/typed 生命周期/冲突收敛/纠正） |

> 火山 RTC 官方文档 PDF（105MB）因超 GitHub 限不入仓，需要时本地放回 `docs/`。

## 后续计划（逐层指标 gate）

- **P0 打通真实链路**（全被"凭据 + LLM 选型"卡着）：
  1. LLM 选型（`config.ts` llm 空占位）+ 火山真实凭据填 `.env`（川哥拍板，阻塞全部真 E2E）；
  2. 真实火山声纹 payload 替换 `mockIdentityPayload` + 契约回放测试；
  3. 声纹注册流（RegisterVoicePrint OpenAPI）；
  4. 真人语音 E2E（Tauri 壳内全双工 + 声纹真区分人 + 串账率真实测量）；
  5. 火山音频属性报告（enableAudioPropertiesReport）接 PulseOrb `pushSignals`；
  6. 火山云→server RTT 实测 + 真实 telemetry p95/p99 汇总。
- **P1 记忆智能补全**：高风险实体确认流（手机号/地址/健康/金额）/ active_stable 阈值参数化 / 真 hot cache + 关键词检索 + pref_summary 收敛 / task+reminder 层 / 治理面板美化。
- **MVP 暂缓**（指标证明缺口再加）：向量召回 / L2 三元组 / 人格 disposition / 反思内核 / 三路并行召回 / 重型夜间 reconcile。

## 快速开始

```bash
pnpm install
cp .env.example .env       # 填火山 RTC/ASR/TTS + LLM 真值
pnpm dev:server
pnpm dev:web

# macOS 桌面壳（Tauri，产 MyJavis.app）
pnpm tauri:build
```

## 与相邻项目的区分

- **realtime-voice-agent**：通用框架（CQRS 记忆内核），刻意**摆脱**火山 RTC（自建 cascade）。MyJavis 是个人助手具体产品，**拥抱**火山 RTC。
- **P003 小可**：儿童陪伴，源头。MyJavis 抽走其火山 RTC 通用语音底座、剥离儿童业务。
- **jarvis-server**：ESP32 硬件语音（小智固件 + Edge-TTS），技术栈不同，无关。
