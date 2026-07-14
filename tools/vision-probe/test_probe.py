"""
vision-probe 算法层单测（无摄像头/无网络）：presence 3 帧防抖、attention 500ms 稳定、
head_tilt 双阈值滞回、nod/shake 往复计数、heartbeat payload 形状（契约 v0.2 语义）。
跑法：python3 test_probe.py
"""

import sys
import types
import unittest
from unittest import mock

# probe.py 顶部 import cv2/mediapipe（Tasks API）——测试环境不需要真包，注入桩后再 import。
sys.modules.setdefault("cv2", types.ModuleType("cv2"))
_mp = types.ModuleType("mediapipe")
_tasks = types.ModuleType("mediapipe.tasks")
_tasks_py = types.ModuleType("mediapipe.tasks.python")
_tasks_vision = types.ModuleType("mediapipe.tasks.python.vision")
_tasks_py.BaseOptions = object
_tasks_vision.FaceLandmarker = object
_tasks_vision.FaceLandmarkerOptions = object
_tasks_vision.RunningMode = types.SimpleNamespace(VIDEO="VIDEO")
_tasks.python = _tasks_py
_tasks_py.vision = _tasks_vision
_mp.tasks = _tasks
sys.modules.setdefault("mediapipe", _mp)
sys.modules.setdefault("mediapipe.tasks", _tasks)
sys.modules.setdefault("mediapipe.tasks.python", _tasks_py)
sys.modules.setdefault("mediapipe.tasks.python.vision", _tasks_vision)

import probe  # noqa: E402


def make_state():
    sender = mock.Mock()
    sender.send = mock.Mock(return_value=True)
    return probe.ProbeState(sender), sender


def sent_kinds(sender):
    return [c.args[1].get("kind") for c in sender.send.call_args_list if c.args[0] == "event"]


class TestPresence(unittest.TestCase):
    def test_three_frame_confirm(self):
        st, sender = make_state()
        st.update_presence(True)
        st.update_presence(True)
        self.assertFalse(st.presence, "2 帧不够翻转")
        st.update_presence(True)
        self.assertTrue(st.presence, "第 3 帧翻转")
        self.assertEqual(sent_kinds(sender), ["person_enter"])

    def test_flicker_no_flip(self):
        st, sender = make_state()
        for _ in range(3):
            st.update_presence(True)
        sender.send.reset_mock()
        # 抖动：单帧丢脸不触发 leave
        st.update_presence(False)
        st.update_presence(True)
        st.update_presence(False)
        self.assertTrue(st.presence)
        self.assertEqual(sent_kinds(sender), [])


class TestAttention(unittest.TestCase):
    def test_stable_500ms_then_shift(self):
        st, sender = make_state()
        for _ in range(3):
            st.update_presence(True)
        sender.send.reset_mock()
        # 正视：t=0 起持续 600ms → screen
        st.update_attention(yaw=5, pitch=3, t_ms=0)
        st.update_attention(yaw=4, pitch=2, t_ms=300)
        self.assertEqual(st.attention, "unknown", "500ms 前不翻转")
        st.update_attention(yaw=6, pitch=1, t_ms=600)
        self.assertEqual(st.attention, "screen")
        self.assertEqual(sent_kinds(sender), ["gaze_shift"])
        # 扭头 40°：短暂 200ms 不翻转，持续 600ms 翻 away
        st.update_attention(yaw=40, pitch=0, t_ms=1000)
        st.update_attention(yaw=42, pitch=0, t_ms=1200)
        self.assertEqual(st.attention, "screen")
        st.update_attention(yaw=45, pitch=0, t_ms=1700)
        self.assertEqual(st.attention, "away")


class TestTilt(unittest.TestCase):
    def test_hysteresis(self):
        st, sender = make_state()
        for _ in range(3):
            st.update_presence(True)
        sender.send.reset_mock()
        # 歪头 20°>15° 持续 500ms → start
        st.update_tilt(roll=20, t_ms=0)
        st.update_tilt(roll=21, t_ms=300)
        self.assertFalse(st.tilt_active)
        st.update_tilt(roll=22, t_ms=600)
        self.assertTrue(st.tilt_active)
        # 回到 10°（8°~15° 滞回带内）不结束
        st.update_tilt(roll=10, t_ms=1200)
        st.update_tilt(roll=10, t_ms=1800)
        self.assertTrue(st.tilt_active, "滞回带内保持 active")
        # 回到 5°<8° 持续 500ms → end
        st.update_tilt(roll=5, t_ms=2000)
        st.update_tilt(roll=4, t_ms=2600)
        self.assertFalse(st.tilt_active)
        kinds = sent_kinds(sender)
        self.assertEqual(kinds, ["head_tilt", "head_tilt"])
        phases = [c.args[1].get("phase") for c in sender.send.call_args_list if c.args[1].get("kind") == "head_tilt"]
        self.assertEqual(phases, ["start", "end"])


class TestNodShake(unittest.TestCase):
    def test_nod_two_reversals(self):
        rc = probe.ReversalCounter()
        # 点头：下-上-下（2 次方向翻转），幅度 14°>10°，1.5s 窗内
        seq = [(0, 0), (150, -7), (300, -14), (450, -7), (600, 0), (750, -7), (900, -14)]
        fired = [rc.push(t, v) for t, v in seq]
        self.assertTrue(any(fired), "往复 ≥2 次应触发")

    def test_small_amplitude_no_fire(self):
        rc = probe.ReversalCounter()
        seq = [(0, 0), (150, -4), (300, 0), (450, -4), (600, 0), (750, -4)]
        self.assertFalse(any(rc.push(t, v) for t, v in seq), "幅度 <10° 不触发")

    def test_cooldown(self):
        rc = probe.ReversalCounter()
        seq = [(0, 0), (150, -12), (300, 0), (450, -12), (600, 0)]
        self.assertTrue(any(rc.push(t, v) for t, v in seq))
        # 冷却期内再往复不触发
        seq2 = [(700, 0), (850, -12), (1000, 0), (1150, -12), (1300, 0)]
        self.assertFalse(any(rc.push(t, v) for t, v in seq2), "2s 冷却内不重复触发")

    def test_slow_drift_no_fire(self):
        rc = probe.ReversalCounter()
        # 单向慢转头（无往复）不触发
        seq = [(i * 150, i * 3.0) for i in range(10)]
        self.assertFalse(any(rc.push(t, v) for t, v in seq))


class TestExpression(unittest.TestCase):
    def test_smile_hold_then_change(self):
        ed = probe.ExpressionDetector()
        smile = {"mouthSmileLeft": 0.8, "mouthSmileRight": 0.75}
        self.assertIsNone(ed.push(smile, 0), "首帧只立候选")
        self.assertIsNone(ed.push(smile, 400), "800ms 前不切换")
        change = ed.push(smile, 900)
        self.assertEqual(change, ("neutral", "smiling"))
        self.assertEqual(ed.current, "smiling")

    def test_flicker_no_change(self):
        ed = probe.ExpressionDetector()
        smile = {"mouthSmileLeft": 0.8, "mouthSmileRight": 0.8}
        blank = {"mouthSmileLeft": 0.1, "mouthSmileRight": 0.1}
        ed.push(smile, 0)
        ed.push(blank, 300)  # 未满 hold 就消失
        ed.push(smile, 600)
        self.assertEqual(ed.current, "neutral", "闪烁不触发")

    def test_neutral_fallback_and_cooldown(self):
        ed = probe.ExpressionDetector()
        smile = {"mouthSmileLeft": 0.8, "mouthSmileRight": 0.8}
        blank = {"mouthSmileLeft": 0.1, "mouthSmileRight": 0.1}
        ed.push(smile, 0)
        ed.push(smile, 900)
        self.assertEqual(ed.current, "smiling")
        # 3s 冷却内回落 neutral 被压制
        ed.push(blank, 1000)
        self.assertIsNone(ed.push(blank, 2000), "冷却内不发变化")
        self.assertEqual(ed.current, "smiling")
        # 冷却过后 neutral 稳定回落
        change = ed.push(blank, 4200)
        self.assertEqual(change, ("smiling", "neutral"))

    def test_yawn_priority_by_score(self):
        ed = probe.ExpressionDetector()
        both = {"mouthSmileLeft": 0.55, "mouthSmileRight": 0.55, "jawOpen": 0.9}
        ed.push(both, 0)
        change = ed.push(both, 700)
        self.assertEqual(change, ("neutral", "yawning"), "多桶命中取分高者")


class FakeDet:
    def __init__(self, label, conf, cx, w=40):
        self.categories = [types.SimpleNamespace(category_name=label, score=conf)]
        self.bounding_box = types.SimpleNamespace(origin_x=cx - w / 2, width=w, origin_y=0, height=40)


class TestObjectTracker(unittest.TestCase):
    def test_stable_after_min_hits(self):
        ot = probe.ObjectTracker()
        for i in range(3):
            ot.push([FakeDet("cup", 0.7, 100)], i * 500, 640)
        objs = ot.stable_list(1500)
        self.assertEqual(len(objs), 1)
        self.assertEqual(objs[0]["label"], "cup")
        self.assertEqual(objs[0]["labelZh"], "杯子")
        self.assertEqual(objs[0]["pos"], "left")

    def test_flicker_not_reported(self):
        ot = probe.ObjectTracker()
        ot.push([FakeDet("dog", 0.6, 320)], 0, 640)
        ot.push([FakeDet("dog", 0.6, 320)], 500, 640)
        self.assertEqual(ot.stable_list(600), [], "命中 <3 次不报")

    def test_gone_after_window(self):
        ot = probe.ObjectTracker()
        for i in range(4):
            ot.push([FakeDet("book", 0.8, 500)], i * 400, 640)
        self.assertEqual(len(ot.stable_list(2000)), 1)
        self.assertEqual(ot.stable_list(2000 + 11_000), [], "窗外离场")

    def test_top_n_by_conf(self):
        ot = probe.ObjectTracker()
        labels = [("cup", 0.9), ("book", 0.8), ("tv", 0.7), ("clock", 0.6), ("vase", 0.55), ("chair", 0.5)]
        for i in range(3):
            ot.push([FakeDet(l, c, 320) for l, c in labels], i * 500, 640)
        objs = ot.stable_list(1500)
        self.assertEqual(len(objs), 5, "top5 截断")
        self.assertEqual(objs[0]["label"], "cup")


class TestHeartbeat(unittest.TestCase):
    def test_payload_shape(self):
        st, _ = make_state()
        # 离席：presence=false + attention=unknown、无 face 节
        p = st.heartbeat_payload(0)
        self.assertEqual(p, {"presence": False, "attention": "unknown"})
        # 在场看屏
        for _ in range(3):
            st.update_presence(True)
        st.head_pose = {"pitch": 1.0, "yaw": -2.0, "roll": 0.5}
        st.attrs = {"eyesOpen": True, "mouthOpen": False}
        st.update_attention(yaw=0, pitch=0, t_ms=0)
        st.update_attention(yaw=0, pitch=0, t_ms=600)
        p = st.heartbeat_payload(700)
        self.assertTrue(p["presence"])
        self.assertEqual(p["attention"], "screen")
        self.assertEqual(p["face"]["headPose"]["yaw"], -2.0)
        self.assertIn("eyesOpen", p["face"]["attrs"])
        self.assertNotIn("expression", p["face"], "neutral 不带 expression 节")
        self.assertNotIn("objects", p, "无稳定物体不带 objects 节")

    def test_payload_with_expression_and_objects(self):
        st, _ = make_state()
        for _ in range(3):
            st.update_presence(True)
        st.head_pose = {"pitch": 0, "yaw": 0, "roll": 0}
        smile = {"mouthSmileLeft": 0.8, "mouthSmileRight": 0.8}
        st.update_expression(smile, 0)
        st.update_expression(smile, 900)
        for i in range(3):
            st.objects.push([FakeDet("cup", 0.7, 320)], i * 400, 640)
        p = st.heartbeat_payload(1300)
        self.assertEqual(p["face"]["expression"]["label"], "smiling")
        self.assertEqual(p["objects"][0]["labelZh"], "杯子")

    def test_leave_resets_pose(self):
        st, _ = make_state()
        for _ in range(3):
            st.update_presence(True)
        st.head_pose = {"pitch": 0, "yaw": 0, "roll": 0}
        for _ in range(3):
            st.update_presence(False)
        p = st.heartbeat_payload(0)
        self.assertFalse(p["presence"])
        self.assertNotIn("face", p, "离席后不带 face 节")


if __name__ == "__main__":
    unittest.main(verbosity=1)
