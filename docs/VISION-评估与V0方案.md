# Vision 视觉感知：gesture demo 结合评估 + V0 方案（2026-07-14）

> 川哥提问：「gesture demo 的面部算法和功能，怎么和 MyJavis 结合，实现看见我、看懂我、了解我的状态和所处环境」。
> 本文档 = cc 评估存档 + 川哥拍板的 V0 执行方案 + 回滚点记录。复盘入口。

---

## 0. 回滚点（V0 开工前基线，2026-07-14）

| 对象 | 基线 | 回滚方式 |
|---|---|---|
| MyJavis 仓 | `80d6a9d`（工作树干净） | `git reset --hard 80d6a9d` |
| mycc 仓（gesture interface README） | `eb2200fa1` | 单文件 revert |
| 生产 server | 0.15.1 healthy（javis.chenchuan.cc/health） | 部署前备份 `dist.bak-vision-v0`，回滚=恢复备份+pm2 restart |
| 生产 App | 0.15.1 | **V0 不发版、App 零改动**（无回滚面） |
| 运行时开关 | `VISION_ENABLED` 默认关 | 生产 .env 不配置=功能不存在；出问题删配置+restart 秒回 |

---

## 1. 评估结论（先行）

**能结合，且接口天然对得上**。值钱的不是搬代码，是三样：

1. **gesture demo 的信号工程范式**（OneEuro 平滑 / FixationGate"盯稳才算" / dwell+衰减 / 迟滞状态机 / 帧确认+不应期）——已在 cc-AirPlayer 二次迁移验证过可移植性；
2. **MyJavis 已有现成注入管道**——音乐播放状态 contextNote 那套（房间级内存状态 → LLM 上下文），视觉状态走同一管道（`custom-llm.ts` contextNote 组装链）；
3. **cc-eye（贾维斯 V3.5）可考古**——川哥前代多模态实验：Qwen2-VL 2B 快扫 10s / 7B 精扫 60s + trylock、dlib 人脸识别、多信号融合 5 状态（疲劳判据：眨眼率 >25/分 + EAR<0.22、5s 滑窗）。「看懂我」的完整前置探索。

### 1.1 gesture demo 资产盘点（基于源码，v3.5）

| 资产 | 对 MyJavis 价值 |
|---|---|
| FaceMesh+Iris、EAR/眨眼（帧确认+不应期）、MAR、眉高、头姿 yaw/pitch/roll、2D gaze | **核心感知原料**：在不在、看没看屏幕、疲劳线索 |
| OneEuro / FixationGate / dwell+衰减 / 迟滞切换 | **防抖范式**（比检测器更值钱） |
| 9 点校准 + 隐式校准 | 大部分用不上——MyJavis 只需"朝向屏幕 vs 看别处"粗粒度，**迁移成本大降** |
| 手势（pinch/拖拽） | 低优（与语音控制重复）；契约 v0.2 手势集 palm/thumbs_up/fist 归 sidecar 正式版 |
| PyInstaller 打包 564MB | 反面教训：探针别追求打包，正式 sidecar 由协作线交付单二进制 |

### 1.2 关键修正（评估→方案的方向调整）

cc 初版评估提出「WebView 内 MediaPipe JS」路线，**随后发现协作架构文档 v1.2（2026-07-09 Owner 已拍板）**：

- vision 运行位 = 端侧 **sidecar 单二进制**（Tauri externalBin，app 拉起，本地采帧本地推理），协作仓 myjavis-vision（实习生自选技术栈）交付，GitHub Releases 制品；
- 契约 v0.2 已裁决（`contracts/vision/`）：L0 heartbeat 1Hz（presence/attention/face{emotion,headPose,attrs}）+ L1 事件（gesture/gaze_shift/enter/leave/head_tilt/expression_change/nod/shake）+ L2 semantic；**红线：帧/landmarks/embedding 永不离开 vision 进程**；
- staging 哑端点已建（`staging/ingest.mjs`，自注明「融合逻辑上线后本服务被真实内核替换」）。

**→ WebView JS 路线废弃**（与拍板冲突，性能探测对 sidecar 架构无意义）。V0 改为做协作架构预留给 core 侧的「真实内核」+ 一个联调探针（见 §3）。

## 2. 功能场景路线图（按价值/风险）

- **P1 在场+注意力+环境**（V0 目标）：Javis 知道"你在/走开/回来/在看屏幕"；后续接 reminder 触达时机（人在才念）；深夜暗光自适应。误检代价低、体感直接。
- **P2 视觉门控防误触发**（杀手级但高风险）：看屏+唇动=对 Javis 说话，扭头对家人说→抑制误响应。与 asr_pvad_gate 结论一致（门控优于降噪）。误门控=Javis 变聋，必须保守策略+灰度开关，套用音乐 FC 上线流程。
- **P3 状态关怀**（宁漏勿误红线）：只做高置信信号——打哈欠/长时间闭眼/久坐→轻量关怀。**不做"情绪识别"过度解读**（契约 emotion 七分类归 sidecar 正式版+精度契约 ≥75% 达标才消费）。
- **P4 远期**：人脸-声纹身份互补（cc-eye dlib 方案，solo 模式价值低）；本地 VLM 分钟级快扫（cc-eye 2B/7B trylock 范式 → 今天用 mlx Qwen3-VL，契约 L2 通道）；「你看这个」主动拍照问答（用户主动=知情，唯一可接受单帧离开感知层的场景）；屏幕上下文（另一半"了解我的状态"，scope 大，留档）。

## 3. V0 方案（2026-07-14 川哥拍板开工）

**定位**：core 侧「真实内核」第一片 + 联调探针。App 零改动（不发版），与协作线互补不抢活——实习生正式 sidecar 交付后，探针退役为契约联调对照，内核不变。

```
tools/vision-probe/（Python 探针，gesture demo 算法改造）
  摄像头 → FaceMesh → presence(3帧防抖)/attention(±30°+500ms)/headPose/attrs
  → 契约 v0.2 JSON：L0 heartbeat 1Hz + L1 事件（enter/leave/gaze_shift/tilt/nod/shake）
  → HTTP POST（帧/landmarks 永不出进程；emotion 不发——无分类器，宁漏勿误）
        ↓
apps/server perception 模块（新增，纯增量）
  POST /perception/ingest：Bearer VISION_INGEST_KEY + 契约信封校验 + 32KB 限制
  → 租户级 visionState 内存 Map（心跳 TTL >3s=离线；L1 近期事件环 30s）
  → 零持久化：不落 DB/不进记忆抽取/日志不落 payload 内容
        ↓
custom-llm.ts contextNote 链（现 [contextNoteText, musicContextNote]）
  + visionContextNote（VISION_ENABLED=1 且状态 fresh 才注入）
        ↓
体验：通话中"你能看到我吗？"→ Javis 答出 在/不在/看屏/刚点头
```

**V0 明确不做**：emotion 分类、手势、L2 场景描述、视觉门控（P2）、reminder 联动、App 集成/发版、多租户探针分发（探针只在川哥本机跑）。

### 验收口径（cc 自验全过才交川哥）
- Gate1：探针输出逐条过契约 schema 校验；ingest/融合/注入单测；本地 E2E（探针→本地 server→模拟轮次见 visionContextNote）。
- Gate2：server 全量测试绿+build 过+App 零 diff。
- 生产：备份先行→部署→探针指生产→真实通话 E2E。

## 4. 红线（继承契约+MyJavis 隐私范式）

1. 原始帧/landmarks/embedding 永不离开采集进程；对外只有契约语义 JSON。
2. visionState 零持久化：内存态 TTL、不落 DB、不进记忆抽取管道、日志不落 payload 内容。
3. 摄像头生命周期：V0 探针手动启停（终端 Ctrl+C）；正式版=通话生命周期，默认关+设置开关。
4. 契约修改权在 Owner（core/contracts/vision 唯一源头）；内核实现只消费不改契约。
5. 测试数据禁用真实办公/家庭录像（契约 §4）；cc 验收用合成帧/本人即时画面，不留存。

---

*署名：cc（Claude）| 2026-07-14*
