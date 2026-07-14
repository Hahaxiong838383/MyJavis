# vision-probe —— Vision V0 联调探针

core 侧参考采集端（cc，2026-07-14）：摄像头 → MediaPipe FaceMesh → 契约 v0.2 PerceptionEvent → `/api/perception/ingest`。算法改造自 `mycc/2-Projects/gesture interface/gesture_drag_demo`。

**定位**：验证 core 内核（ingest→visionState→visionContextNote）端到端 + 川哥真机体验「Javis 看见我」。协作仓正式 sidecar（单二进制）交付后，本探针退役为契约联调对照。

## 运行

```bash
cd tools/vision-probe
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python probe.py --key <X-Javis-Key> --server https://javis.chenchuan.cc
# 本地 dev： --server http://127.0.0.1:3001；调试窗口加 --show
```

server 侧需 `VISION_ENABLED=1`（生产 .env 加行 + pm2 restart；不配=功能关闭 503）。

## 上报内容（只有语义 JSON，红线见 contracts/vision/README.md）

- L0 heartbeat 1Hz：presence（3 帧防抖）/ attention（±30°+500ms 稳定）/ face.headPose / face.attrs(eyesOpen, mouthOpen)
- L1 事件：person_enter/leave、gaze_shift、head_tilt（15°/8° 滞回）、head_nod / head_shake（1.5s 窗往复≥2 次 >10°，2s 冷却）
- **不上报**：emotion（无分类器，宁漏勿误）、手势、任何帧/landmarks/embedding

## 已知边界（V0 接受）

- 头姿为几何近似（鼻尖偏移比例粗标定），精度契约（≤5°）的达标验收归正式 sidecar；explicit 阈值都可在 probe.py 顶部调。
- 单人假设（max_num_faces=1）；多人场景归正式版。
- 摄像头授权：首跑 macOS 会向终端 App（Terminal/iTerm）弹摄像头权限，允许后重跑。
