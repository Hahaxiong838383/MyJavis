# MyJavis 优化全景 ROADMAP

> 2026-07-07 立档（cc 全项目盘点 + 川哥拍板）。后续 session 接手：先读 `HANDOFF.md`，规划下一轮开发看本文件。
> 状态标记：⬜ 未开始 · 🔨 进行中 · ✅ 完成 · ❄️ 冻结

---

## 0. 背景

v0.10.0 内测阶段全项目盘点结论：四层架构（语音 I/O/声纹/记忆/前端）+ 音乐 + 多租户分发全部生产可用；P0 保命三件（判停真生效/updater 私钥双备/DB 备份双拉+Kuma 告警）2026-07-07 已闭环。本文件汇总其后的待优化全景与优先级。

## 1. 全景清单（按优先级）

| 优先 | 项 | 一句话 | 成本 | 状态 |
|---|---|---|---|---|
| P1 | ⭐ Reminder 主动提醒 | 三档触达 + 错过补报 + 复述确认，主动性质变 | 中 | ✅ v0.11.0 |
| P1 | 声纹优化包 S1-S3 | 名字确认/语音删除/满员话术，修真机踩过的坑 | 小 | ✅ v0.11.0 |
| P1 | 判停 1000ms 真机体感复测 | 2026-07-07 才真生效（pm2 快照坑），川哥用两天反馈 | 零 | ⬜ 等反馈 |
| P2 | 记忆架构两层化 R1-R4 | **App 内隐私 vault（tauri-plugin-sql+jieba-wasm+分层记忆）+ 云端长线层，同构双部署（共享包 @myjavis/memory-core）**；方案定稿 [memory-architecture.md](./memory-architecture.md)（2026-07-07 川哥拍板，Ollama 档不做）。**R1+R1.1 ✅ v0.12.0**（云端检索相关性化+召回预览+版本对齐）**R2 ✅ v0.13.0**（本机隐私 vault：分类器三层锚点+hold/拉/焚+session-context 通话注入分人红线+脱敏三道防线含 assistant 复述+tray 常驻+登录自启开关；提炼代理挪 R4）**R3 ✅ v0.14.0**（bi-temporal 失效保历史+LLM 批处理精修+「记忆活动」实时面板(川哥点名)+疑问句防误抽当场修）**R3.5 ✅ v0.15.0**（记忆体验断裂修复：生产实锤零声纹租户记忆全不工作——单人模式默认开箱即用+引导闭环口头提醒+治理面板owner点选+对话历史面板新UI，详见 04-决策记录.md 2026-07-08）→ **R4 ✅ v0.17.0**（2026-07-14 Sonnet worktree 委派：夜间巩固 ephemeral/dormant/对账/profile 重算 + 提炼代理零落盘 + App 挂断攒批消费）。记忆架构两层化 R1-R4 全部收官。backlog：vault Mini 加密备份 | 中大 | 🔄 R1-R3.5 完成 |
| P2 | 音乐体验包 | 搜索 ranking 音乐向/播完自动下一首/循环随机/音量绝对值/收藏（详见 music-orchestrator TODO.md P1） | 中 | ⬜ |
| P2 | ⭐ 意图路由 AI 化 M1（音乐控制 FC PoC） | 撞词根治终局（2026-07-08 川哥拍板）：音乐控制类正则 → 主 LLM function calling，播放状态注入上下文由 LLM 语义裁决（同一次调用零额外延迟）；**边界：reminder 时间解析 / enroll 状态机保持规则（确定性红线，不 AI 化）**。PoC 先验三风险：赛马×流式 FC 兼容 / tool_call 不漏 TTS / 控制指令延迟实测，数据说话再全量。委派 prompt：[IMPL-音乐意图AI化-PROMPT.md](./IMPL-音乐意图AI化-PROMPT.md) | 中（PoC ~1d） | ✅ **M1 灰度上线 2026-07-09**（Sonnet5 worktree 执行+cc 对抗验收：撞词 0/10(description反例补丁根治100%误判)/真指令11/11/p95 890ms；DeepSeek 单路+正则降级链+abort守卫；生产 MUSIC_FC_ENABLED=1）。第二片点歌域先做 Gate1 式 query 提取探测再定 | 
| P2 | ⭐ Vision 视觉感知 V0（core 内核+探针） | 「看见我」第一片（2026-07-14 川哥拍板）：perception ingest+visionState 融合+visionContextNote 注入 + vision-probe 探针（gesture demo 算法改造，契约 v0.2）。对齐协作架构 v1.2 sidecar 拍板。评估+路线图（P1 在场注意力→P2 视觉门控→P3 关怀→P4 VLM）：[VISION-评估与V0方案.md](./VISION-评估与V0方案.md) | 中 | ✅ **V0+0.16.0 上线 2026-07-14**（生产 VISION_ENABLED=1 + App 通话生命周期自动拉起探针 + getUserMedia 确权，川哥真机验收通过）。下一片：P2 视觉门控防误触发（先攒真机体感）；正式 sidecar 交付后换 resolve_probe 目标即可 |
| P2 | 高风险实体确认流 | 手机号/地址/健康/金额复述后才 committed（HANDOFF P1-7） | 小中 | ⬜ |
| P3 | 租户使用观测 | 谁在用/记忆增长/错误率小看板，指导内测迭代 | 小 | ⬜ |
| P3 | 冷路径 Autodreaming 轻量版 | 夜间对账+过期清理+pref_summary 收敛；等观测数据说明必要性再上 | 中 | ⬜ |
| P3 | 菜单栏常驻 + 登录自启 | reminder 覆盖时间拉满（Tauri tray） | 小 | ⬜ |
| P4 | 治理面板美化 / KWS 步5 状态机收敛 / telemetry p95 汇总 | 工程尾巴 | 小 | ⬜ |
| ❄️ | Tauri 真签名（上架才需）/ LLM 第三路（拍板 C 维持现状）/ L2 三元组·人格（指标 gate 未到） | 明确不动 | — | ❄️ |

> 2026-07-07 变更：原 ❄️ 中"向量召回"经川哥拍板重新规划记忆架构而解冻，并入 P2 记忆架构两层化（见 memory-architecture.md）；开源重方案（hindsight/OpenViking）仍留远期 gate。

## 2. Reminder v1 设计（第一轮主菜）

### 2.1 三档触达（回答"要不要一直开 App"：不用）

| 到点时用户状态 | 触达 | 实现 |
|---|---|---|
| 通话中 | Javis 房间内直接开口 | server 调 `ExternalTextToSpeech`（声纹注册播报已验证此通道） |
| App 开着(含最小化) | 系统通知 + 本地念出 | App 独立于通话轮询 `/api/reminders/due` → Tauri 通知 + WKWebView `speechSynthesis`（零计费不拉火山房间） |
| App 没开 | 错过补报 | 到点无人接 → `missed`；下次通话首轮 contextNote 注入，Javis 主动带出"你错过了 X 条提醒" |

### 2.2 设计红线
- **时间解析 = 确定性规则**（自写解析器，不让 LLM 猜时间）；解析不出 → Javis 反问"什么时候提醒你？"（awaiting_time 状态机，仿声纹 awaiting_name 范式）。
- **复述确认**：设置成功直接短路回复"好的，X月X日 HH:MM 提醒你：内容"（跳过 LLM 直出）——复述本身是纠错窗口，设置可逆（可语音取消）故不强制等"对"。
- 意图正则**宁漏勿误**（声纹 enroll 教训：意图句式拿真机 ASR 原话校准）。
- 多租户隔离贯穿（reminder 表带 tenant_id，API 走 X-Javis-Key）。

### 2.3 数据与调度
- 独立 `reminder` 表（id/tenant_id/owner_id/content/due_at/status/created_at/fired_at/delivered_via/room_id）；status: `pending→fired→delivered|missed`，可 `cancelled`。不塞 memory_item（调度语义不同）。
- server 内 30s tick 调度器：扫 due → 有活跃房间先试 RTC 插播（失败降级）→ 无房间置 `fired` 等 App 轮询取走（ack 回执）→ fired 超 30min 无人接置 `missed`。
- 意图：设置（提醒我…）/ 取消（取消提醒/别提醒了）/ 查询（我有什么提醒）。

### 2.4 时间解析器 v1 支持面（窄而准，反问兜底）
相对（N秒/N分钟/半小时/N小时后）· 今天/明天/后天 + 段位词（早上/上午/中午/下午/晚上/凌晨，各有默认时刻）· N点(半/N分/一刻/三刻) · HH:MM 直写 · 中文数字（含"两"）。时刻已过默认明天。周N/具体日期 v1 不做（反问兜底）。

## 3. 声纹优化包（第一轮捎带 S1-S3）

| # | 项 | 问题（真机记录） | 方案 | 状态 |
|---|---|---|---|---|
| S1 | 注册名字确认 | "唱歌"误注册占名额（awaiting_name 把闲聊当名字） | 裸名字复述确认后才开录（带"我叫"前缀直录，少打扰） | ✅ |
| S2 | 语音删除声纹 | "忘掉 X 的声音"无意图，只能面板手动删 | 删除意图 + 二次确认（宁漏勿误） | ✅ |
| S3 | 满员话术 | 3 人上限（火山 Mode=2 硬限）满员时无引导 | 满员时报名单 + 引导"忘掉某某的声音" | ✅ |
| S4 | Score 阈值弹药 | 默认 50；某人总认不出时 | 50→40 每租户可调 | ⬜ 按数据 |
| S5 | 身份粘滞 TTL | 短句物理无标签，现 30s 粘滞（仅称呼层） | 真机用感决定是否加长 | ⬜ 按反馈 |
| S6 | 注册后当前房间不生效 | 火山限制（IdList 仅 Start 传，热更仅 Mode=0） | "下次通话生效"话术已自洽 | ❄️ 无解不动 |

## 4. 第一轮验收口径（BRO-PDCA 的 C）
- Gate1：时间解析器单测全绿（各表达+边界）；意图正则含反例测试；本地 E2E（设 1 分钟提醒→tick→触达/轮询全链路）；声纹 S1-S3 状态机 E2E。
- Gate2：现有测试全过（记忆/治理/声纹回归零破坏）；server+web tsc/build 过。
- 生产：部署后公网 E2E（真实设提醒→due 轮询取到→ack）；发版 App 后 cc 先验，再交川哥体验。
