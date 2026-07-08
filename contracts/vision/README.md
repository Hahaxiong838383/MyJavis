# 视觉感知契约(PerceptionEvent)v0.1 —— 草稿,待 Owner 裁决

> 本目录是契约唯一源头(core/contracts/vision/)。协作仓中的 contracts/ 为只读副本,
> 由 scripts/sync-contracts.sh 单向下发。修改权仅在 Owner;消费者视角的意见走协作仓 issue。

## 1. 格式契约

传输:WebSocket(staging 端点)或 HTTP POST /perception/ingest。
消息一律为 UTF-8 JSON,单条 ≤ 32KB。信封结构见 perception-event.schema.json,要点:

| 字段 | 类型 | 说明 |
|---|---|---|
| v | string | 契约版本,如 "0.1.0",与 CONTRACT_VERSION 一致 |
| type | enum | heartbeat / event / semantic(对应 L0/L1/L2) |
| seq | int | 单调递增序号,进程重启归零 + session_id 更换 |
| session_id | string | 采集进程一次运行的唯一 id(uuid) |
| ts_mono_ms | number | 单调时钟毫秒(必填,排序/融合依据) |
| ts_wall_ms | number | 墙钟毫秒(展示用,不参与排序) |
| payload | object | 按 type 区分,见 schema |

- **只传语义事件:不传帧、不传 embedding、不传任何图像派生二进制。**
- 未知字段:接收端忽略;发送端不得依赖未在 schema 中声明的字段。

## 2. 语义契约(每个事件何时发出、消费方可假设什么)

### L0 heartbeat(状态心跳,1Hz ± 0.2s)
- presence: 视野内是否有人(连续 3 帧一致才翻转,防抖)。
- attention: screen / away / unknown。"screen"=面部朝向屏幕法线 ±30° 且持续 ≥500ms。
- 消费方可假设:心跳缺失 >3s 即视为采集端离线。

### L1 event(离散事件,事件驱动)
- gesture: 手势保持 ≥300ms 才触发;同一手势 2s 冷却,期间不重复上报。
  - v0.1 手势集:palm(手掌)/ thumbs_up(点赞)/ fist(握拳)。
- gaze_shift: attention 状态翻转且新状态稳定 ≥500ms 时上报一次(携带 from/to)。
- person_enter / person_leave: presence 翻转即上报(防抖同 L0)。
- 消费方可假设:L1 事件不保证与 L0 心跳严格同步,但 seq 与 ts_mono_ms 全局单调。

### L2 semantic(场景语义,按需或 ≤0.2Hz)
- description: 一句话中文场景描述;objects: 主要物体标签 + 置信度。
- 触发:收到 staging 端点下行的 describe 请求,或本地定时(默认关)。

## 3. 时序契约

- ts_mono_ms 必须来自单调时钟(如 CLOCK_MONOTONIC),用于事件排序与延迟测量。
- 连接建立后第一条消息必须是 hello:{ v, session_id, ts_mono_ms, ts_wall_ms }。
  接收端校验 v 与自身 CONTRACT_VERSION,主版本不匹配 → 关闭连接(code 4001)。
- hello 应答携带服务端墙钟,发送端据此计算 clock_offset 供本地日志对齐(不回传)。
- 同一 session 内 seq 严格递增;接收端可按 seq 去重。

## 4. 精度契约(bench 目标 = 验收标准;初值待 Owner 校准)

| 指标 | 目标 |
|---|---|
| L1 手势端到端延迟(动作完成→事件到达) | ≤ 200ms(p95) |
| L1 手势误触发 | ≤ 2 次/小时(常规室内光照) |
| L0 attention 准确率 | ≥ 90%(标注集) |
| L2 描述延迟 | ≤ 3s(p95) |
| 事件丢失率(网络正常) | 0(允许断线重连后 seq 跳变) |

测试数据:公开数据集 + 自录素材。禁止使用任何真实场景办公/家庭录像。
