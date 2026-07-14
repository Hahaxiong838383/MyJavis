"""
真实推理链路回归（需 .venv 真 mediapipe；test_probe.py 是纯逻辑桩测，两者互补）：
官方公开测试人像（契约 §4 允许的数据源）→ FaceLandmarker → extract_features 断言。
跑法：.venv/bin/python verify_inference.py
"""

import math
import sys

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision

sys.argv = ["probe"]
import probe  # noqa: E402

IMG = "testdata/portrait.jpg"  # https://storage.googleapis.com/mediapipe-assets/portrait.jpg

model = probe.ensure_model()
lmk = mp_vision.FaceLandmarker.create_from_options(
    mp_vision.FaceLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=model),
        running_mode=mp_vision.RunningMode.IMAGE,
        num_faces=1,
    )
)
img = cv2.imread(IMG)
assert img is not None, f"缺测试图 {IMG}（curl -sL -o {IMG} https://storage.googleapis.com/mediapipe-assets/portrait.jpg）"
h, w = img.shape[:2]
res = lmk.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
assert res.face_landmarks, "官方人像应检出人脸"
lm = res.face_landmarks[0]
assert len(lm) == 478

pose, attrs = probe.extract_features(lm, w, h)
print("headPose:", pose, "| attrs:", attrs)
# 正面人像：三轴都应接近 0（±15° 容差，几何粗标）；attention 门（±30°）必须判 screen
assert abs(pose["yaw"]) < 15, f"正面 yaw 应近 0，实际 {pose['yaw']}"
assert abs(pose["pitch"]) < 15, f"正面 pitch 应近 0，实际 {pose['pitch']}"
assert abs(pose["roll"]) < 15, f"正面 roll 应近 0，实际 {pose['roll']}"
assert attrs["eyesOpen"] is True, "睁眼人像 eyesOpen 应为 True"
assert attrs["mouthOpen"] is False, "闭嘴人像 mouthOpen 应为 False"

# 纵横比不变性：同一 landmarks 在 16:9 与 4:5 容器下特征应一致（归一化坐标×各自宽高）
pose2, attrs2 = probe.extract_features(lm, w * 2, h * 2)
assert abs(pose["pitch"] - pose2["pitch"]) < 0.2 and attrs == attrs2, "等比缩放应不变"

print("✓ verify_inference 全过（真实推理→特征提取→attention 域）")
