#!/usr/bin/env python3
"""
vision-probe —— MyJavis Vision V0 联调探针（core 侧参考采集端，2026-07-14）。

摄像头 → MediaPipe FaceMesh → presence/attention/headPose/attrs →
契约 v0.2 PerceptionEvent（L0 heartbeat 1Hz + L1 离散事件）→ HTTP POST /api/perception/ingest。

算法源自 mycc/2-Projects/gesture interface/gesture_drag_demo（face_tracker.py 关键点索引、
头姿几何估计、帧确认防抖范式）；阈值与语义按 contracts/vision/README.md v0.2 实现。

红线（契约 + docs/VISION-评估与V0方案.md §4）：
  - 原始帧 / landmarks / 任何 embedding 永不离开本进程；对外只有契约语义 JSON。
  - emotion 不上报（本探针无表情分类器，宁漏勿误；契约 face.emotion 为可选字段）。
  - 正式 sidecar（协作仓交付单二进制）上线后，本探针退役为契约联调对照。

用法：
  python3 probe.py --server http://127.0.0.1:3001 --key <X-Javis-Key> [--camera 0] [--show]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from urllib import error, request

try:
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision as mp_vision
except ImportError as e:  # pragma: no cover
    print(f"[probe] 缺依赖: {e}。先 pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)

CONTRACT_VERSION = "0.2.0"

# 模型（mediapipe 0.10.30+ Tasks API）。首跑自动下载缓存（走系统代理）。
_MODEL_DIR = __file__.rsplit("/", 1)[0] + "/models"
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
MODEL_PATH = _MODEL_DIR + "/face_landmarker.task"
# lite0→lite2（2026-07-14 真机实锤：lite0 手持小物弱区——鼠标零检出/瓶子误检手机遥控器；
# lite2 12MB/55ms，2fps 场景占用 11% 无压力，官方图对比置信度显著更高）
OBJ_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite"
OBJ_MODEL_PATH = _MODEL_DIR + "/efficientdet_lite2.tflite"

# ---- 关键点索引（复制自 gesture_drag_demo/face_tracker.py，MediaPipe FaceMesh 468 点拓扑） ----
LEFT_EYE_EAR_IDX = [33, 160, 158, 133, 153, 144]
RIGHT_EYE_EAR_IDX = [362, 385, 387, 263, 373, 380]
NOSE_TIP = 1
LEFT_EYE_OUTER = 33
RIGHT_EYE_OUTER = 263
MOUTH_TOP, MOUTH_BOTTOM, MOUTH_LEFT, MOUTH_RIGHT = 13, 14, 61, 291

# ---- 阈值（契约 §2 语义 + 探针自定检测参数） ----
PRESENCE_CONFIRM_FRAMES = 3        # 契约：presence 连续 3 帧一致才翻转
ATTENTION_ANGLE_DEG = 30.0         # 契约："screen"=面部朝向屏幕法线 ±30°
ATTENTION_STABLE_MS = 500          # 契约：且持续 ≥500ms（gaze_shift 同阈值）
TILT_START_DEG, TILT_END_DEG = 15.0, 8.0   # 契约：head_tilt 双阈值滞回
TILT_HOLD_MS = 500
NOD_SHAKE_WINDOW_MS = 1500         # 契约：1.5s 窗口往复 ≥2 次、幅度 >10°
NOD_SHAKE_AMPLITUDE_DEG = 10.0
NOD_SHAKE_COOLDOWN_MS = 2000
REVERSAL_HYST_DEG = 3.0            # 往复方向翻转迟滞（防噪声假往复，探针自定）
EAR_OPEN_THRESHOLD = 0.15          # eyesOpen 判定：官方正面人像睁眼实测 EAR≈0.20，闭眼典型 <0.12
MAR_OPEN_THRESHOLD = 0.5           # mouthOpen=张大嘴（打哈欠级；说话不算，保守）
# 几何比例→角度粗标定（像素域）。基线 0.47 = MediaPipe 官方正面人像 nose_dy/eye_span 实测；
# scale 为线性近似（V0 用途仅 attention ±30° 门与 nod/shake >10° 幅度，精度契约归正式 sidecar）。
YAW_SCALE, PITCH_SCALE = 150.0, 150.0
NOSE_PITCH_BASELINE = 0.47

HEARTBEAT_INTERVAL_S = 1.0         # 契约 L0：1Hz ± 0.2s
PROCESS_FPS = 15                   # 处理帧率（检测足够，省电）

# ---- 级联切片1：blendshape 表情三桶（契约 v0.3 face.expression；宁漏勿误：高阈值+持续门控） ----
# 阈值定标依据：官方微笑人像实测 mouthSmile≈0.95（阈 0.5 裕度充分）、闭嘴 jawOpen≈0.12、
# 睁眼 blink≈0.26；哈欠为大张嘴 jawOpen 取 0.6；闭眼≠眨眼故持续取 1.5s。
EXPR_RULES = {
    "smiling": {"keys": ("mouthSmileLeft", "mouthSmileRight"), "th": 0.65, "hold_ms": 800},  # 0.5→0.65：真机实证非笑嘴部动作(生气咧嘴/苦笑)误触发,官方标准微笑0.95仍有裕度
    "yawning": {"keys": ("jawOpen",), "th": 0.6, "hold_ms": 600},
    "eyes_closed": {"keys": ("eyeBlinkLeft", "eyeBlinkRight"), "th": 0.6, "hold_ms": 1500},
    # 负面两桶（2026-07-14 川哥拍板 demo 全面测试）：初值按 blendshape 典型幅度保守给，
    # 真机日志（[hb] 行 bs[...] 调试分量）校准迭代。frowning=皱眉(生气样)、sad=撇嘴+眉心上提(低落样)。
    # 阈值据川哥真脸日志校准(2026-07-14)：皱眉 bd 实测 0.23-0.39、撇嘴 mf 实测 0.30-0.59。
    # veto：大笑会挤眉(实测 bd=0.39 且 sm=0.86 同帧)——微笑分量高时不判负面。
    "frowning": {"keys": ("browDownLeft", "browDownRight"), "th": 0.28, "hold_ms": 800, "veto": ("mouthSmileLeft", "mouthSmileRight"), "veto_th": 0.4},
    "sad": {"keys": ("mouthFrownLeft", "mouthFrownRight"), "th": 0.28, "hold_ms": 1000, "veto": ("mouthSmileLeft", "mouthSmileRight"), "veto_th": 0.4},
}
EXPR_NEUTRAL_HOLD_MS = 800          # 条件消失持续这么久才回 neutral
EXPR_CHANGE_COOLDOWN_MS = 3000      # 契约 §2：同向变化 3s 冷却

# ---- 级联切片2：物体检测（契约 v0.3 heartbeat.objects；滑窗投票平滑防逐帧闪烁） ----
OBJ_DETECT_EVERY_N = 8              # 15fps 处理循环里每 8 帧跑一次 ≈ 2fps
OBJ_SCORE_THRESHOLD = 0.35  # 0.45→0.35：真机手持鼠标/瓶子漏检(近距畸变+遮挡分数低)
OBJ_WINDOW_MS = 10_000              # 滑窗：窗内命中 ≥3 次判在场，0 次判离场
OBJ_MIN_HITS = 2                    # 3→2：手持展示几秒即放下,降攒帧门槛
OBJ_TOP_N = 5                       # 心跳最多报 5 个（契约上限 8）

# COCO 80 类中文映射（EfficientDet-Lite0 标签集；person 已在 detector denylist 过滤）
COCO_ZH = {
    "person": "人", "bicycle": "自行车", "car": "汽车", "motorcycle": "摩托车", "airplane": "飞机",
    "bus": "公交车", "train": "火车", "truck": "卡车", "boat": "船", "traffic light": "红绿灯",
    "fire hydrant": "消防栓", "stop sign": "停车牌", "parking meter": "停车计时器", "bench": "长椅",
    "bird": "鸟", "cat": "猫", "dog": "狗", "horse": "马", "sheep": "羊", "cow": "牛",
    "elephant": "大象", "bear": "熊", "zebra": "斑马", "giraffe": "长颈鹿", "backpack": "背包",
    "umbrella": "雨伞", "handbag": "手提包", "tie": "领带", "suitcase": "行李箱", "frisbee": "飞盘",
    "skis": "滑雪板", "snowboard": "单板滑雪板", "sports ball": "球", "kite": "风筝",
    "baseball bat": "棒球棒", "baseball glove": "棒球手套", "skateboard": "滑板", "surfboard": "冲浪板",
    "tennis racket": "网球拍", "bottle": "瓶子", "wine glass": "酒杯", "cup": "杯子", "fork": "叉子",
    "knife": "刀", "spoon": "勺子", "bowl": "碗", "banana": "香蕉", "apple": "苹果",
    "sandwich": "三明治", "orange": "橙子", "broccoli": "西兰花", "carrot": "胡萝卜",
    "hot dog": "热狗", "pizza": "披萨", "donut": "甜甜圈", "cake": "蛋糕", "chair": "椅子",
    "couch": "沙发", "potted plant": "盆栽", "bed": "床", "dining table": "桌子", "toilet": "马桶",
    "tv": "电视", "laptop": "笔记本电脑", "mouse": "鼠标", "remote": "遥控器", "keyboard": "键盘",
    "cell phone": "手机", "microwave": "微波炉", "oven": "烤箱", "toaster": "烤面包机",
    "sink": "水槽", "refrigerator": "冰箱", "book": "书", "clock": "钟", "vase": "花瓶",
    "scissors": "剪刀", "teddy bear": "玩偶", "hair drier": "吹风机", "toothbrush": "牙刷",
}


def now_mono_ms() -> float:
    return time.monotonic() * 1000.0


@dataclass
class Sender:
    """契约传输端：hello 先行、seq 单调、失败不崩（丢弃+限频告警）。"""

    server: str
    key: str
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    seq: int = 0
    _last_err_log: float = 0.0

    def send(self, msg_type: str, payload: dict) -> bool:
        body = {
            "v": CONTRACT_VERSION,
            "type": msg_type,
            "seq": self.seq,
            "session_id": self.session_id,
            "ts_mono_ms": now_mono_ms(),
            "ts_wall_ms": time.time() * 1000.0,
            "payload": payload,
        }
        self.seq += 1
        data = json.dumps(body).encode("utf-8")
        req = request.Request(
            f"{self.server}/api/perception/ingest",
            data=data,
            headers={"Content-Type": "application/json", "X-Javis-Key": self.key},
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=3) as resp:
                return resp.status == 200
        except (error.URLError, error.HTTPError, TimeoutError, OSError) as e:
            t = time.monotonic()
            if t - self._last_err_log > 5:  # 5s 限频，断网时不刷屏
                detail = getattr(e, "code", None) or getattr(e, "reason", e)
                print(f"[probe] 上报失败(丢弃继续): {detail}", file=sys.stderr)
                self._last_err_log = t
            return False


class ReversalCounter:
    """nod/shake 检测：滑窗内角度序列的往复（方向翻转）计数，带迟滞。"""

    def __init__(self) -> None:
        self.samples: deque[tuple[float, float]] = deque()  # (t_ms, deg)
        self.last_fire_ms = -1e12

    def push(self, t_ms: float, deg: float) -> bool:
        self.samples.append((t_ms, deg))
        while self.samples and t_ms - self.samples[0][0] > NOD_SHAKE_WINDOW_MS:
            self.samples.popleft()
        if t_ms - self.last_fire_ms < NOD_SHAKE_COOLDOWN_MS or len(self.samples) < 4:
            return False
        vals = [v for _, v in self.samples]
        if max(vals) - min(vals) < NOD_SHAKE_AMPLITUDE_DEG:
            return False
        # 方向翻转计数：位移超过迟滞才认一次方向
        reversals, direction, anchor = 0, 0, vals[0]
        for v in vals[1:]:
            delta = v - anchor
            if abs(delta) < REVERSAL_HYST_DEG:
                continue
            d = 1 if delta > 0 else -1
            if direction != 0 and d != direction:
                reversals += 1
            direction = d
            anchor = v
        if reversals >= 2:
            self.last_fire_ms = t_ms
            self.samples.clear()
            return True
        return False


class ExpressionDetector:
    """blendshape → 三桶表情状态机（阈值+持续门控+neutral 回落+变化冷却，宁漏勿误）。"""

    def __init__(self) -> None:
        self.current = "neutral"
        self._cand: str | None = None
        self._cand_since = 0.0
        self._last_change_ms = -1e12

    @staticmethod
    def _bucket_of(scores: dict) -> tuple[str, float]:
        """当帧命中的桶（多桶同时命中取分最高；都不中= neutral）。"""
        best, best_score = "neutral", 0.0
        for label, rule in EXPR_RULES.items():
            vals = [scores.get(k, 0.0) for k in rule["keys"]]
            avg = sum(vals) / len(vals)
            if avg < rule["th"]:
                continue
            veto = rule.get("veto")
            if veto:  # 互斥保护：冲突分量高则本桶弃权（如大笑挤眉不算皱眉）
                v_avg = sum(scores.get(k, 0.0) for k in veto) / len(veto)
                if v_avg >= rule.get("veto_th", 0.4):
                    continue
            if avg > best_score:
                best, best_score = label, avg
        return best, best_score

    def push(self, scores: dict, t_ms: float) -> tuple[str, str] | None:
        """喂一帧 blendshape 分数表；发生稳定切换时返回 (from, to)，否则 None。"""
        target, score = self._bucket_of(scores)
        if target != self._cand:
            self._cand = target
            self._cand_since = t_ms
            self._cand_score = score
            return None
        hold = EXPR_NEUTRAL_HOLD_MS if target == "neutral" else EXPR_RULES[target]["hold_ms"]
        if target != self.current and t_ms - self._cand_since >= hold:
            if t_ms - self._last_change_ms < EXPR_CHANGE_COOLDOWN_MS:
                return None
            prev, self.current = self.current, target
            self._last_change_ms = t_ms
            self.confidence = round(score, 2)
            return (prev, target)
        return None


class ObjectTracker:
    """物体滑窗投票平滑：窗内命中≥N 判在场（防逐帧闪烁），0 命中判离场。"""

    def __init__(self) -> None:
        self._hits: dict[str, deque] = {}  # label -> deque[(t_ms, conf, pos)]

    def push(self, detections: list, t_ms: float, frame_w: float) -> None:
        for d in detections:
            c = d.categories[0]
            cx = d.bounding_box.origin_x + d.bounding_box.width / 2
            pos = "left" if cx < frame_w / 3 else ("right" if cx > frame_w * 2 / 3 else "center")
            self._hits.setdefault(c.category_name, deque()).append((t_ms, c.score, pos))
        self._expire(t_ms)

    def _expire(self, t_ms: float) -> None:
        for label in list(self._hits):
            q = self._hits[label]
            while q and t_ms - q[0][0] > OBJ_WINDOW_MS:
                q.popleft()
            if not q:
                del self._hits[label]

    def stable_list(self, t_ms: float) -> list[dict]:
        self._expire(t_ms)
        out = []
        for label, q in self._hits.items():
            if len(q) < OBJ_MIN_HITS:
                continue
            _, conf, pos = q[-1]
            out.append({
                "label": label,
                "labelZh": COCO_ZH.get(label, label),
                "pos": pos,
                "confidence": round(conf, 2),
            })
        out.sort(key=lambda o: -o["confidence"])
        return out[:OBJ_TOP_N]


class ProbeState:
    """presence/attention/tilt 状态机（帧确认 + 持续时间 + 滞回，gesture demo 防抖范式）。"""

    def __init__(self, sender: Sender) -> None:
        self.sender = sender
        self.presence = False
        self._presence_streak = 0
        self.attention = "unknown"  # screen / away / unknown（对外值）
        self._att_candidate = "unknown"
        self._att_since_ms = 0.0
        self.tilt_active = False
        self._tilt_cond_since: float | None = None
        self._tilt_end_since: float | None = None
        self.nod = ReversalCounter()
        self.shake = ReversalCounter()
        self.head_pose: dict | None = None
        self.attrs: dict | None = None
        self.expr = ExpressionDetector()          # 切片1：表情三桶
        self.objects = ObjectTracker()            # 切片2：物体平滑

    # -- presence：连续 3 帧一致才翻转（契约） --
    def update_presence(self, detected: bool) -> None:
        if detected == self.presence:
            self._presence_streak = 0
            return
        self._presence_streak += 1
        if self._presence_streak >= PRESENCE_CONFIRM_FRAMES:
            self.presence = detected
            self._presence_streak = 0
            self.sender.send("event", {"kind": "person_enter" if detected else "person_leave", "confidence": 0.9})
            print(f"[probe] event: {'person_enter' if detected else 'person_leave'}")
            if not detected:
                # 离席时收敛姿态相关状态，防复位后旧窗口误触发
                self.attention = "unknown"
                self._att_candidate = "unknown"
                self.head_pose = None
                self.attrs = None
                self.nod.samples.clear()
                self.shake.samples.clear()

    # -- attention：±30° 且稳定 ≥500ms 才翻转；翻转即 gaze_shift（契约） --
    def update_attention(self, yaw: float, pitch: float, t_ms: float) -> None:
        target = "screen" if (abs(yaw) <= ATTENTION_ANGLE_DEG and abs(pitch) <= ATTENTION_ANGLE_DEG) else "away"
        if target != self._att_candidate:
            self._att_candidate = target
            self._att_since_ms = t_ms
            return
        if target != self.attention and t_ms - self._att_since_ms >= ATTENTION_STABLE_MS:
            prev = self.attention
            self.attention = target
            self.sender.send("event", {"kind": "gaze_shift", "from": prev, "to": target, "confidence": 0.8})
            print(f"[probe] event: gaze_shift {prev}→{target}")

    # -- head_tilt：|roll|>15° 持续 500ms start；回落 <8° 持续 500ms end（双阈值滞回，契约） --
    def update_tilt(self, roll: float, t_ms: float) -> None:
        if not self.tilt_active:
            if abs(roll) > TILT_START_DEG:
                if self._tilt_cond_since is None:
                    self._tilt_cond_since = t_ms
                elif t_ms - self._tilt_cond_since >= TILT_HOLD_MS:
                    self.tilt_active = True
                    self._tilt_cond_since = None
                    direction = "right" if roll > 0 else "left"
                    self.sender.send(
                        "event",
                        {"kind": "head_tilt", "phase": "start", "direction": direction, "angle": round(roll, 1)},
                    )
                    print(f"[probe] event: head_tilt start {direction} {roll:.1f}°")
            else:
                self._tilt_cond_since = None
        else:
            if abs(roll) < TILT_END_DEG:
                if self._tilt_end_since is None:
                    self._tilt_end_since = t_ms
                elif t_ms - self._tilt_end_since >= TILT_HOLD_MS:
                    self.tilt_active = False
                    self._tilt_end_since = None
                    self.sender.send("event", {"kind": "head_tilt", "phase": "end"})
                    print("[probe] event: head_tilt end")
            else:
                self._tilt_end_since = None

    def update_nod_shake(self, yaw: float, pitch: float, t_ms: float) -> None:
        if self.nod.push(t_ms, pitch):
            self.sender.send("event", {"kind": "head_nod", "confidence": 0.8})
            print("[probe] event: head_nod")
        if self.shake.push(t_ms, yaw):
            self.sender.send("event", {"kind": "head_shake", "confidence": 0.8})
            print("[probe] event: head_shake")

    def update_expression(self, blend_scores: dict, t_ms: float) -> None:
        change = self.expr.push(blend_scores, t_ms)
        if change:
            frm, to = change
            self.sender.send(
                "event",
                {"kind": "expression_change", "from": frm, "to": to, "confidence": getattr(self.expr, "confidence", 0.7)},
            )
            print(f"[probe] event: expression_change {frm}→{to}")

    def heartbeat_payload(self, now_ms: float | None = None) -> dict:
        payload: dict = {"presence": self.presence, "attention": self.attention if self.presence else "unknown"}
        if self.presence and self.head_pose:
            face: dict = {"headPose": self.head_pose}
            if self.attrs:
                face["attrs"] = self.attrs
            if self.expr.current != "neutral":
                face["expression"] = {"label": self.expr.current, "confidence": getattr(self.expr, "confidence", 0.7)}
            payload["face"] = face
        objs = self.objects.stable_list(now_ms if now_ms is not None else now_mono_ms())
        if objs:
            payload["objects"] = objs
        return payload


# ---- 几何特征（gesture demo face_tracker 范式；landmarks 只在本函数栈内存活） ----
# 距离一律在像素域计算：MediaPipe landmark 是宽/高各自归一化坐标，直接 hypot 混轴会被
# 图像纵横比系统性缩放（16:9 与 4:5 下同一张脸 EAR 差 ~2x，官方测试图实测踩过）。


def _dist_px(a, b, w: float, h: float) -> float:
    return math.hypot((a.x - b.x) * w, (a.y - b.y) * h)


def ear_of(lm, idx, w: float, h: float) -> float:
    p1, p2, p3, p4, p5, p6 = (lm[i] for i in idx)
    horiz = _dist_px(p1, p4, w, h)
    return (_dist_px(p2, p6, w, h) + _dist_px(p3, p5, w, h)) / (2 * horiz) if horiz > 1e-6 else 0.0


def extract_features(lm, w: float, h: float) -> tuple[dict, dict]:
    """FaceLandmarker landmarks → (headPose°, attrs)。几何近似标定，精度契约验收在 sidecar 正式版。"""
    le, re, nose = lm[LEFT_EYE_OUTER], lm[RIGHT_EYE_OUTER], lm[NOSE_TIP]
    eye_cx, eye_cy = (le.x + re.x) / 2 * w, (le.y + re.y) / 2 * h
    eye_span = max(_dist_px(le, re, w, h), 1e-6)
    yaw = ((nose.x * w - eye_cx) / eye_span) * YAW_SCALE  # 鼻尖水平偏移比例 → 度
    pitch = -((nose.y * h - eye_cy) / eye_span - NOSE_PITCH_BASELINE) * PITCH_SCALE
    roll = math.degrees(math.atan2((re.y - le.y) * h, (re.x - le.x) * w))  # 双眼连线角
    ear = (ear_of(lm, LEFT_EYE_EAR_IDX, w, h) + ear_of(lm, RIGHT_EYE_EAR_IDX, w, h)) / 2
    mouth_h = _dist_px(lm[MOUTH_TOP], lm[MOUTH_BOTTOM], w, h)
    mouth_w = max(_dist_px(lm[MOUTH_LEFT], lm[MOUTH_RIGHT], w, h), 1e-6)
    head_pose = {"pitch": round(pitch, 1), "yaw": round(yaw, 1), "roll": round(roll, 1)}
    attrs = {"eyesOpen": ear > EAR_OPEN_THRESHOLD, "mouthOpen": (mouth_h / mouth_w) > MAR_OPEN_THRESHOLD}
    return head_pose, attrs


def ensure_model(url: str = MODEL_URL, path: str = MODEL_PATH, name: str = "FaceLandmarker") -> str:
    import os

    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print(f"[probe] 首跑下载 {name} 模型 → {path}")
    tmp = path + ".part"
    with request.urlopen(url, timeout=60) as resp, open(tmp, "wb") as f:
        f.write(resp.read())
    os.rename(tmp, path)
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description="MyJavis vision-probe（契约 v0.2 联调探针）")
    ap.add_argument("--server", default="http://127.0.0.1:3001", help="MyJavis server 地址")
    ap.add_argument("--key", required=True, help="X-Javis-Key（租户邀请码=事件归属）")
    ap.add_argument("--camera", type=int, default=0, help="摄像头索引")
    ap.add_argument("--show", action="store_true", help="调试窗口（仅本机显示，画面不外传）")
    args = ap.parse_args()

    print(f"[probe] boot {time.strftime('%F %T')} → {args.server} camera={args.camera}")
    model_path = ensure_model()
    obj_model_path = ensure_model(OBJ_MODEL_URL, OBJ_MODEL_PATH, "ObjectDetector(EfficientDet-Lite0)")
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        print("[probe] 摄像头打不开（检查系统设置→隐私→摄像头授权，或换 --camera 索引）", file=sys.stderr)
        sys.exit(2)

    sender = Sender(server=args.server.rstrip("/"), key=args.key)
    sender.send("hello", {"probe": "vision-probe", "contract": CONTRACT_VERSION})
    print(f"[probe] session={sender.session_id[:8]} → {args.server}（Ctrl+C 退出）")

    landmarker = mp_vision.FaceLandmarker.create_from_options(
        mp_vision.FaceLandmarkerOptions(
            base_options=mp_tasks.BaseOptions(model_asset_path=model_path),
            running_mode=mp_vision.RunningMode.VIDEO,
            num_faces=1,
            min_face_detection_confidence=0.5,
            min_tracking_confidence=0.5,
            output_face_blendshapes=True,  # 切片1：52 blendshapes（表情三桶原料）
        )
    )
    obj_detector = mp_vision.ObjectDetector.create_from_options(
        mp_vision.ObjectDetectorOptions(
            base_options=mp_tasks.BaseOptions(model_asset_path=obj_model_path),
            running_mode=mp_vision.RunningMode.VIDEO,
            max_results=8,
            score_threshold=OBJ_SCORE_THRESHOLD,
            category_denylist=["person"],  # 人走 face 通道，物体列表不报
        )
    )
    state = ProbeState(sender)
    last_hb, frame_interval = 0.0, 1.0 / PROCESS_FPS
    frame_no = 0
    try:
        while True:
            t_frame = time.monotonic()
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.2)
                continue
            frame = cv2.resize(frame, (640, 360))  # 降采样：检测够用，省算力
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            t_ms = now_mono_ms()
            frame_no += 1
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = landmarker.detect_for_video(mp_img, int(t_ms))
            detected = bool(result.face_landmarks)
            state.update_presence(detected)
            if detected and state.presence:
                lm = result.face_landmarks[0]
                head_pose, attrs = extract_features(lm, 640, 360)
                state.head_pose, state.attrs = head_pose, attrs
                state.update_attention(head_pose["yaw"], head_pose["pitch"], t_ms)
                state.update_tilt(head_pose["roll"], t_ms)
                state.update_nod_shake(head_pose["yaw"], head_pose["pitch"], t_ms)
                if result.face_blendshapes:
                    scores = {c.category_name: c.score for c in result.face_blendshapes[0]}
                    state.update_expression(scores, t_ms)
                    state.last_bs_debug = (
                        f"bd={max(scores.get('browDownLeft',0),scores.get('browDownRight',0)):.2f} "
                        f"mf={max(scores.get('mouthFrownLeft',0),scores.get('mouthFrownRight',0)):.2f} "
                        f"sm={max(scores.get('mouthSmileLeft',0),scores.get('mouthSmileRight',0)):.2f} "
                        f"jo={scores.get('jawOpen',0):.2f}"
                    )

            # 切片2：物体检测 ~2fps（每 8 帧），滑窗投票平滑
            if frame_no % OBJ_DETECT_EVERY_N == 0:
                obj_result = obj_detector.detect_for_video(mp_img, int(t_ms))
                state.objects.push(obj_result.detections, t_ms, 640)
                if obj_result.detections:  # raw 检出日志（平滑前），校准/排障用
                    raw = ",".join(f"{d.categories[0].category_name}:{d.categories[0].score:.2f}" for d in obj_result.detections)
                    print(f"[obj-raw] {raw}")

            if time.monotonic() - last_hb >= HEARTBEAT_INTERVAL_S:
                last_hb = time.monotonic()
                payload = state.heartbeat_payload(t_ms)
                state.sender.send("heartbeat", payload)
                hp = state.head_pose or {}
                objs = ",".join(o["labelZh"] for o in payload.get("objects", [])) or "-"
                print(
                    f"[hb] presence={state.presence} attention={state.attention} "
                    f"expr={state.expr.current} objs=[{objs}] "
                    f"yaw={hp.get('yaw', '-')} pitch={hp.get('pitch', '-')} roll={hp.get('roll', '-')} "
                    f"bs[{getattr(state, 'last_bs_debug', '-')}]"
                )

            if args.show:
                label = f"{'IN' if state.presence else 'OUT'} {state.attention}"
                cv2.putText(frame, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                cv2.imshow("vision-probe (local only)", frame)
                if cv2.waitKey(1) & 0xFF == 27:
                    break
            # 处理帧率限速
            spare = frame_interval - (time.monotonic() - t_frame)
            if spare > 0:
                time.sleep(spare)
    except KeyboardInterrupt:
        print("\n[probe] bye")
    finally:
        cap.release()
        if args.show:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
