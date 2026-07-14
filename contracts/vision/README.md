# 视觉感知契约(PerceptionEvent)v0.3 —— Owner 已裁决

> 本目录是契约唯一源头(core/contracts/vision/)。协作仓中的 contracts/ 为只读副本,
> 由 scripts/sync-contracts.sh 单向下发。修改权仅在 Owner;消费者视角的意见走协作仓 issue。
>
> **红线(最高优先)**:原始帧、面部 landmarks、任何 embedding **永不离开 vision 进程**。
> 对外可见的只有本契约定义的语义 JSON。

## 0. v0.3 变更摘要(相对 v0.2,向后兼容;2026-07-14 Owner 拍板级联架构)

- L0 heartbeat.payload 新增可选 `objects` 节(≤8 项):本地物体检测的**时间平滑后稳定列表**
  `{ label(COCO 英文), labelZh(中文), pos(left/center/right 粗位), confidence }`。
  上报"滑窗投票稳定在场"的物体,不上报逐帧闪烁;帧与检测框坐标不出采集进程。
- L0 face 新增可选 `expression` 节:`{ label ∈ smiling/yawning/eyes_closed, confidence }`。
  与 `emotion`(分类器七类,归 sidecar 正式版)**正交**——expression 是 blendshape/几何高置信
  瞬时信号(阈值+持续时间门控,宁漏勿误),两者可并存。
- L1 `expression_change` 的 from/to 值域扩展:在七类表情基础上追加 expression 三值 + neutral。
- 信封零改动;v0.2 消息仍然合法。

## 0.1 v0.2 变更摘要(相对 v0.1,向后兼容)

- L0 heartbeat.payload 新增可选 `face` 节:表情 / 头部姿态 / 面部语义属性。
- L1 event.kind 新增:`head_tilt` / `expression_change` / `head_nod` / `head_shake`。
- `from`/`to` 字段放宽为 string,值域随 kind 而定(见 §2)。
- 信封结构零改动;不带 `face` 的 v0.1 消息仍然合法。

## 1. 格式契约

传输:WebSocket(staging 端点)或 HTTP POST /perception/ingest。
消息一律为 UTF-8 JSON,单条 ≤ 32KB。信封结构见 perception-event.schema.json,要点:

| 字段 | 类型 | 说明 |
|---|---|---|
| v | string | 契约版本,如 "0.2.0",与 CONTRACT_VERSION 一致 |
| type | enum | heartbeat / event / semantic(对应 L0/L1/L2) |
| seq | int | 单调递增序号,进程重启归零 + session_id 更换 |
| session_id | string | 采集进程一次运行的唯一 id(uuid) |
| ts_mono_ms | number | 单调时钟毫秒(必填,排序/融合依据) |
| ts_wall_ms | number | 墙钟毫秒(展示用,不参与排序) |
| payload | object | 按 type 区分,见 schema |

- **只传语义事件:不传帧、不传 landmarks、不传 embedding、不传任何图像派生二进制。**
- 未知字段:接收端忽略;发送端不得依赖未在 schema 中声明的字段。

## 2. 语义契约(每个事件何时发出、消费方可假设什么)

### L0 heartbeat(状态心跳,1Hz ± 0.2s)
- presence: 视野内是否有人(连续 3 帧一致才翻转,防抖)。
- attention: screen / away / unknown。"screen"=面部朝向屏幕法线 ±30° 且持续 ≥500ms。
- **face(v0.2 新增,presence=true 时应携带)**:
  - `emotion`: { label, confidence }。label 七类:neutral / happy / sad / angry / surprised / confused / tired。
    上报"当前稳定表情"(≥800ms 时间平滑后),不上报逐帧抖动值。
  - `headPose`: { pitch, yaw, roll },单位度,正方向:pitch 抬头+ / yaw 右转+ / roll 右歪+。roll 即"歪头"轴。
  - `attrs`: { eyesOpen, mouthOpen, glasses } 布尔,可选。
- 消费方可假设:心跳缺失 >3s 即视为采集端离线;face 缺失=该帧未检出人脸,非错误。

### L1 event(离散事件,事件驱动)
- gesture: 手势保持 ≥300ms 才触发;同一手势 2s 冷却。v0.2 手势集:palm / thumbs_up / fist。
- gaze_shift: attention 状态翻转且新状态稳定 ≥500ms 时上报一次(from/to = attention 值域)。
- person_enter / person_leave: presence 翻转即上报(防抖同 L0)。
- **head_tilt(v0.2)**:|roll| > 15° 持续 ≥500ms → `phase:"start"`(带 direction: left/right 与当时 angle);
  回落 |roll| < 8° 持续 ≥500ms → `phase:"end"`。双阈值滞回,防边界抖动。
- **expression_change(v0.2)**:新表情置信度 >0.6 且持续 ≥800ms 才触发(from/to = 表情值域);
  同向变化 3s 冷却。宁漏勿误:不确定就不报。
- **head_nod / head_shake(v0.2)**:pitch(nod)/yaw(shake)在 1.5s 窗口内往复 ≥2 次、幅度 >10° 触发,
  一次性事件(无 phase),2s 冷却。
- 消费方可假设:L1 事件不保证与 L0 心跳严格同步,但 seq 与 ts_mono_ms 全局单调。
- `from`/`to` 值域随 kind:gaze_shift → attention 枚举;expression_change → 表情枚举。

### L2 semantic(场景语义,按需或 ≤0.2Hz)
- description: 一句话中文场景描述;objects: 主要物体标签 + 置信度。
- 触发:收到 staging 端点下行的 describe 请求,或本地定时(默认关)。

## 3. 时序契约

- ts_mono_ms 必须来自单调时钟(如 CLOCK_MONOTONIC),用于事件排序与延迟测量。
- 连接建立后第一条消息必须是 hello:{ v, session_id, ts_mono_ms, ts_wall_ms }。
  接收端校验 v 与自身 CONTRACT_VERSION,主版本不匹配 → 关闭连接(code 4001)。
- hello 应答携带服务端墙钟,发送端据此计算 clock_offset 供本地日志对齐(不回传)。
- 同一 session 内 seq 严格递增;接收端可按 seq 去重。

## 4. 精度契约(bench 目标 = 验收标准;初值待实测校准)

| 指标 | 目标 |
|---|---|
| L1 手势端到端延迟(动作完成→事件到达) | ≤ 200ms(p95) |
| L1 手势误触发 | ≤ 2 次/小时(常规室内光照) |
| L0 attention 准确率 | ≥ 90%(标注集) |
| **headPose 角度误差(v0.2)** | ≤ 5°(标注集) |
| **表情七分类准确率(v0.2)** | ≥ 75%(标注集) |
| **head_tilt / nod / shake 误触发(v0.2)** | ≤ 2 次/小时 |
| **expression_change 误触发(v0.2)** | ≤ 4 次/小时 |
| L2 描述延迟 | ≤ 3s(p95) |
| 事件丢失率(网络正常) | 0(允许断线重连后 seq 跳变) |

测试数据:公开数据集 + 自录素材。禁止使用任何真实场景办公/家庭录像。
