from __future__ import annotations

import argparse
import base64
import json
import math
import statistics
import threading
import time
from collections import deque
from datetime import datetime, timedelta
import urllib.request
from pathlib import Path
from dotenv import load_dotenv

import cv2
import numpy as np
import torch
from ultralytics import YOLO

load_dotenv(Path(__file__).resolve().parent / ".env")

# Ngưỡng Healthy khớp health_status_vi (≥85 → Healthy).
HEALTHY_PERCENT_MIN = 85.0
PUMP_TRIGGER_PERCENT = 80.0
HEALTH_MEDIAN_WINDOW_SAMPLES = 60
# Trước khi đủ median trên 5 mẫu (sau baseline), UI dùng stable_ui; trước đó dùng % khung hình — tránh ổn định 100% giả.
MIN_FRAMES_FOR_STABLE_HEALTH_UI = 5

# Demo: cosine sức khỏe ảo theo độ dài video (blockchain/demo UI).
DEMO_HEALTH_CURVE_BASELINE = 80.0
DEMO_HEALTH_CURVE_AMPLITUDE = 20.0

# --- Demo ingest: POST full payload có iot (_vision_iot_derived), cách nhau ít nhất 10 giây.
DEMO_INGEST_INTERVAL_SEC = 10.0

# --- Realtime POST /home/api/realtime: héo (không Healthy) — chống spam; hoặc "tim đập" lành sau mỗi 20 phút.
REALTIME_VISION_HEALTH_PING_SEC = 20 * 60
REALTIME_VISION_WILT_MIN_GAP_SEC = 60.0


def _demo_simulated_health(progress: float) -> float:
    progress = max(0.0, min(1.0, progress))
    return DEMO_HEALTH_CURVE_BASELINE + DEMO_HEALTH_CURVE_AMPLITUDE * math.cos(2.0 * math.pi * progress)


def open_video_capture(video_path: str) -> cv2.VideoCapture | None:
    candidates = [video_path]
    cleaned = video_path.strip().rstrip("/")
    if cleaned.startswith(("http://", "https://")):
        if cleaned.endswith("/video"):
            candidates.extend(
                [
                    cleaned.replace("/video", "/mjpegfeed"),
                    cleaned.replace("/video", "/mjpegfeed?640x480"),
                ]
            )
        elif cleaned.endswith("/v"):
            candidates.extend(
                [
                    f"{cleaned}ideo",
                    cleaned.replace("/v", "/mjpegfeed"),
                    cleaned.replace("/v", "/mjpegfeed?640x480"),
                ]
            )
        else:
            candidates.extend([f"{cleaned}/video", f"{cleaned}/mjpegfeed", f"{cleaned}/mjpegfeed?640x480"])

    seen: set[str] = set()
    unique_candidates: list[str] = []

    for source in candidates:
        normalized = source.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            unique_candidates.append(normalized)

    for source in unique_candidates:
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            cap.release()
            continue

        print(f"✅ THÀNH CÔNG: AI đã kết nối được với Camera điện thoại! source={source}")
        return cap

    print(f"❌ LỖI TRẦM TRỌNG: AI không thể đọc được luồng video từ {video_path}")
    print(f"Tried sources: {', '.join(unique_candidates)}")
    return None


def _post_json(api_url: str, payload: dict, *, timeout_sec: float) -> bool:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(api_url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def post_sensor_data(api_url: str, payload: dict) -> bool:
    return _post_json(api_url, payload, timeout_sec=4.0)


def post_tracking_data(api_url: str, payload: dict) -> bool:
    return _post_json(api_url, payload, timeout_sec=2.0)


def health_status_vi(health_percent: float) -> str:
    if health_percent < 75.0:
        return "Héo"
    if health_percent < HEALTHY_PERCENT_MIN:
        return "Héo nhẹ"
    return "Healthy"


def _vision_iot_derived(health_percent: float) -> tuple[str, float, float, float, str]:
    """IoT giả cho demo video: đất ẩm tăng dần theo % lá (liên tục), không nhảy bước tại ngưỡng 75/85.

    Trước đây độ ẩm phụ thuộc nhánh status → tại ví dụ 84.9% vs 85% đất nhảy ~13% ↔ ~92% (vỡ biểu đồ).
    Bơm / status vẫn theo ngưỡng Healthy (≥85) như cũ.
    """
    hp = max(0.0, min(100.0, float(health_percent)))
    status = health_status_vi(hp)
    conf = round(max(0.2, min(0.99, hp / 100.0)), 4)
    # Một đường monotone: hp thấp → đất khô hơn, hp cao → ẩm hơn (~22%–~94%).
    t = hp / 100.0
    soil_raw = 10.0 + 84.0 * (t**0.92)
    soil = round(max(8.0, min(97.0, soil_raw)), 2)
    temp = round(28.0 + (100.0 - hp) * 0.07, 2)
    pump = "ON" if status != "Healthy" else "OFF"
    return status, conf, soil, temp, pump


def encode_frame_base64(frame: np.ndarray) -> str:
    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    if not ok:
        return ""
    encoded = base64.b64encode(buffer).decode("utf-8")
    return f"data:image/jpeg;base64,{encoded}"


def _masks_geometry_from_result(result, frame: np.ndarray) -> tuple[list, list, int]:
    contours_to_draw: list = []
    axes_to_draw: list = []
    total_leaf_pixels = 0
    
    #Đếm số lượng leaf trong frame
    if result.masks is None:
        return contours_to_draw, axes_to_draw, total_leaf_pixels
    
    frame_h, frame_w = frame.shape[:2]
    union_mask = np.zeros((frame_h, frame_w), dtype=np.uint8)
    segments = result.masks.xy

    for seg in segments:
        if len(seg) > 0:
            pts = np.int32([seg])
            cv2.fillPoly(union_mask, pts, 255)
    total_leaf_pixels = int(cv2.countNonZero(union_mask))
    contours, _ = cv2.findContours(union_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    #Vẽ polygon cho từng leaf
    for contour in contours:
        if cv2.contourArea(contour) <= 120:
            continue
        contours_to_draw.append(contour)
        points = contour.reshape(-1, 2).astype(np.float32)
        if points.shape[0] < 2:
            continue
        #Tính toán trục chính của leaf
        mean = points.mean(axis=0)
        centered = points - mean
        cov = np.cov(centered, rowvar=False)
        eig_vals, eig_vecs = np.linalg.eig(cov)
        principal_vec = eig_vecs[:, np.argmax(eig_vals)].real
        principal_vec = principal_vec / (np.linalg.norm(principal_vec) + 1e-8)
        x, y, w, h = cv2.boundingRect(contour)
        axis_len = int((w + h) * 0.3)
        cx, cy = int(mean[0]), int(mean[1])
        dx = int(principal_vec[0] * axis_len)
        dy = int(principal_vec[1] * axis_len)
        axes_to_draw.append(((cx - dx, cy - dy), (cx + dx, cy + dy)))

    return contours_to_draw, axes_to_draw, total_leaf_pixels


def run_demo_mode(
    video_path: str,
    *,
    model_path: str,
    demo_ingest_url: str,
    tracking_api_url: str,
    tree_id: str,
    send_every_frames: int,
    start_hour: int,
    end_hour: int,
) -> None:
    """Demo file video: AI đo % héo; IoT chỉ sinh qua _vision_iot_derived; POST /home/api/demo mỗi ~10s."""
    model = YOLO(model_path)
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    model_imgsz = 640 if device.startswith("cuda") else 512
    leaf_conf_threshold = 0.3

    cap = open_video_capture(video_path)
    if cap is None:
        print(f"Cannot open video: {video_path}")
        return

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if not np.isfinite(source_fps) or source_fps <= 1:
        source_fps = 30.0
    if total_frames <= 0:
        print("Demo mode expects a finite video file (frame_count > 0).")
        cap.release()
        return

    now = datetime.now()
    real_start = now.replace(hour=start_hour, minute=0, second=0, microsecond=0)
    real_end = (real_start + timedelta(days=1)).replace(hour=end_hour)
    timeline_seconds = max((real_end - real_start).total_seconds(), 1.0)
    second_per_frame = timeline_seconds / max(total_frames - 1, 1)

    baseline_area = None
    frame_index = 0
    ingest_sent = 0
    CALIBRATION_SECONDS = 4
    calibration_frames = max(1, int(round(source_fps * CALIBRATION_SECONDS)))
    calibration_locked_logged = False
    health_median_window = deque[float](maxlen=HEALTH_MEDIAN_WINDOW_SAMPLES)
    last_demo_ingest_wall = 0.0
    cal_area_samples: list[int] = []
    post_cal_baseline_locked = False

    print(
        f"[DEMO MODE] POST mỗi {DEMO_INGEST_INTERVAL_SEC:.0f}s → {demo_ingest_url}\n"
        f"  tracking → {tracking_api_url}\n"
        f"  IoT giả (đất ẩm liên tục theo % lá) + bơm từ _vision_iot_derived(median % lá CV); cos chỉ log debug.\n"
        "  Telegram: backend xử lý khi nhận POST /demo — CV không gửi Telegram trong demo.\n"
    )

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        frame_index += 1
        if frame_index % send_every_frames != 0 and frame_index != total_frames:
            continue

        results = model(frame, imgsz=model_imgsz, conf=leaf_conf_threshold, device=device, verbose=False)
        result = results[0]
        contours_to_draw, axes_to_draw, total_leaf_pixels = _masks_geometry_from_result(result, frame)

        if frame_index <= calibration_frames:
            cal_area_samples.append(total_leaf_pixels)
            baseline_area = max(1, int(round(statistics.median(cal_area_samples))))
        elif not post_cal_baseline_locked:
            if cal_area_samples:
                baseline_area = max(1, int(round(statistics.median(cal_area_samples))))
            post_cal_baseline_locked = True

        if not calibration_locked_logged and frame_index > calibration_frames:
            print(
                f"🔒 Baseline locked after {CALIBRATION_SECONDS}s | baseline_area={max(baseline_area or 1, 1)}"
            )
            calibration_locked_logged = True

        health_percent = (float(total_leaf_pixels) / float(max(baseline_area, 1))) * 100.0
        health_percent = max(0.0, min(100.0, health_percent))
        health_median_window.append(health_percent)
        median_n = len(health_median_window)
        measured_stable_health = (
            float(statistics.median(health_median_window)) if median_n > 0 else health_percent
        )
        measured_stable_health = max(0.0, min(100.0, measured_stable_health))

        calibration_complete = frame_index > calibration_frames
        health_ready = calibration_complete and median_n >= MIN_FRAMES_FOR_STABLE_HEALTH_UI
        stable_ui = measured_stable_health if health_ready else health_percent
        stable_ui = max(0.0, min(100.0, stable_ui))

        demo_progress = (frame_index - 1) / max(total_frames - 1, 1)
        timeline_cosine_health = max(0.0, min(100.0, _demo_simulated_health(demo_progress)))

        stable_status_tg, stable_conf_snapshot, stable_soil_snapshot, stable_temp_snapshot, stable_pump_snapshot = (
            _vision_iot_derived(stable_ui)
        )

        video_second = max(0.0, (frame_index - 1) / source_fps)
        mapped_timestamp = real_start + timedelta(seconds=(frame_index - 1) * second_per_frame)

        frame_h, frame_w = frame.shape[:2]
        image_base64 = encode_frame_base64(frame)
        tracking_payload = {
            "tree_id": tree_id,
            "stream_mode": "demo_video",
            "telegram_from_overlay": False,
            "median_window_n": median_n,
            "median_window_max": HEALTH_MEDIAN_WINDOW_SAMPLES,
            "frame_index": frame_index,
            "total_frames": total_frames,
            "video_second": video_second,
            "video_time": video_second,
            "frame_width": frame_w,
            "frame_height": frame_h,
            "polygons": [contour.reshape(-1, 2).astype(int).tolist() for contour in contours_to_draw],
            "axes": [{"pt1": [pt1[0], pt1[1]], "pt2": [pt2[0], pt2[1]], "label": "Target Leaf"} for pt1, pt2 in axes_to_draw],
            "health_status": stable_status_tg,
            "health_percent": round(stable_ui, 2),
            "leaf_area_pixels": int(total_leaf_pixels),
            "health_percent_instant": round(health_percent, 2),
            "health_status_instant": health_status_vi(health_percent),
            "calibration_complete": calibration_complete,
            "health_ready_for_stable": health_ready,
            "mapped_timestamp": mapped_timestamp.isoformat(),
            "image_base64": image_base64,
            "demo_iot": {
                "soil_moisture": stable_soil_snapshot,
                "temperature": stable_temp_snapshot,
                "pump_status": stable_pump_snapshot,
            },
        }
        threading.Thread(target=post_tracking_data, args=(tracking_api_url, tracking_payload), daemon=True).start()

        wall = time.time()
        if wall - last_demo_ingest_wall >= DEMO_INGEST_INTERVAL_SEC or frame_index == total_frames:
            last_demo_ingest_wall = wall
            if median_n > 0:
                payload = {
                    "tree_id": tree_id,
                    "timestamp": mapped_timestamp.isoformat(),
                    "ai_vision_data": {
                        "health_status": stable_status_tg,
                        "confidence_score": stable_conf_snapshot,
                        "camera_image_url": f"/videos/final.mp4#t={video_second:.2f}",
                    },
                    "iot_data": {
                        "soil_moisture": stable_soil_snapshot,
                        "temperature": stable_temp_snapshot,
                        "pump_status": stable_pump_snapshot,
                    },
                    "action_taken": f"Demo ingest frame={frame_index}/{total_frames} t_ảo={mapped_timestamp.strftime('%H:%M')}",
                }
                ok = post_sensor_data(demo_ingest_url, payload)
                ingest_sent += 1 if ok else 0

                print(
                    f"🔥 [DEMO INGEST] {'OK' if ok else 'FAIL'}: {stable_ui:.1f}% | {stable_status_tg} | "
                    f"pump={stable_pump_snapshot} | t_ảo={mapped_timestamp.strftime('%H:%M')}"
                )

        print(
            f"frame={frame_index}/{total_frames} area={total_leaf_pixels} "
            f"stable_ui={stable_ui:.1f}% cos_dbg={timeline_cosine_health:.1f}% "
            f"instant={health_percent:.1f}% ({median_n}/{HEALTH_MEDIAN_WINDOW_SAMPLES}) demo_ingest"
        )

    cap.release()
    print(f"Done demo mode. Ingest posts (approx): {ingest_sent}.")


def run_realtime_mode(
    camera_url: str,
    *,
    model_path: str,
    realtime_vision_url: str,
    tracking_api_url: str,
    tree_id: str,
    send_every_frames: int,
) -> None:
    """Camera (DroidCam…): AI đo % héo; KHÔNG _vision_iot_derived; POST /home/api/realtime khi héo (throttle) hoặc 20p/lần."""
    model = YOLO(model_path)
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    rotate_right = camera_url.strip().rstrip("/") == "http://192.168.1.3:4747/video"
    model_imgsz = 640 if device.startswith("cuda") else 512
    leaf_conf_threshold = 0.3

    cap = open_video_capture(camera_url)
    if cap is None:
        print(f"Cannot open camera: {camera_url}")
        return

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if not np.isfinite(source_fps) or source_fps <= 1:
        source_fps = 30.0
    if total_frames <= 0:
        total_frames = 1

    live_start = datetime.now()
    baseline_area = None
    frame_index = 0
    vision_posts = 0
    CALIBRATION_SECONDS = 4
    calibration_frames = max(1, int(round(source_fps * CALIBRATION_SECONDS)))
    calibration_locked_logged = False
    health_median_window = deque[float](maxlen=HEALTH_MEDIAN_WINDOW_SAMPLES)
    last_realtime_vision_post_wall = 0.0
    last_wilt_vision_post_wall = -1.0
    cal_area_samples: list[int] = []
    post_cal_baseline_locked = False

    print(
        f"[REALTIME MODE] vision → {realtime_vision_url} (không IoT giả lập)\n"
        f"  tracking → {tracking_api_url}\n"
        f"  Gửi vision: héo cách ≥{REALTIME_VISION_WILT_MIN_GAP_SEC:.0f}s, hoặc lành mỗi {REALTIME_VISION_HEALTH_PING_SEC // 60} phút.\n"
        "  Telegram realtime: backend (tracking overlay telegram_from_overlay=true).\n"
    )

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            print("⚠️ [STREAM] Mất frame từ camera, thử kết nối lại...")
            cap.release()
            time.sleep(1.0)
            cap = open_video_capture(camera_url)
            if cap is None:
                print("❌ [STREAM] Không reconnect được camera, dừng stream.")
                break
            continue

        if rotate_right:
            frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)

        frame_index += 1
        if frame_index % send_every_frames != 0:
            continue

        results = model(frame, imgsz=model_imgsz, conf=leaf_conf_threshold, device=device, verbose=False)
        result = results[0]
        contours_to_draw, axes_to_draw, total_leaf_pixels = _masks_geometry_from_result(result, frame)

        if frame_index <= calibration_frames:
            cal_area_samples.append(total_leaf_pixels)
            baseline_area = max(1, int(round(statistics.median(cal_area_samples))))
        elif not post_cal_baseline_locked:
            if cal_area_samples:
                baseline_area = max(1, int(round(statistics.median(cal_area_samples))))
            post_cal_baseline_locked = True

        if not calibration_locked_logged and frame_index > calibration_frames:
            print(
                f"🔒 Baseline locked after {CALIBRATION_SECONDS}s | baseline_area={max(baseline_area or 1, 1)}"
            )
            calibration_locked_logged = True

        health_percent = (float(total_leaf_pixels) / float(max(baseline_area, 1))) * 100.0
        health_percent = max(0.0, min(100.0, health_percent))
        health_median_window.append(health_percent)
        median_n = len(health_median_window)
        current_stable_health = (
            float(statistics.median(health_median_window)) if median_n > 0 else health_percent
        )
        current_stable_health = max(0.0, min(100.0, current_stable_health))

        calibration_complete = frame_index > calibration_frames
        health_ready = calibration_complete and median_n >= MIN_FRAMES_FOR_STABLE_HEALTH_UI
        stable_ui = current_stable_health if health_ready else health_percent
        stable_ui = max(0.0, min(100.0, stable_ui))

        stable_status_tg = health_status_vi(stable_ui)
        conf_for_api = round(max(0.2, min(0.99, stable_ui / 100.0)), 4)

        instant_status_vi = health_status_vi(health_percent)

        wall_now = datetime.now()
        wall = time.time()
        video_second = (wall_now - live_start).total_seconds()
        mapped_timestamp = wall_now

        wilted = health_status_vi(stable_ui) != "Healthy"
        should_post_vision = False
        if wilted:
            if (
                last_wilt_vision_post_wall < 0
                or wall - last_wilt_vision_post_wall >= REALTIME_VISION_WILT_MIN_GAP_SEC
            ):
                should_post_vision = True
                last_wilt_vision_post_wall = wall
        else:
            if last_realtime_vision_post_wall == 0.0 or wall - last_realtime_vision_post_wall >= REALTIME_VISION_HEALTH_PING_SEC:
                should_post_vision = True
                last_realtime_vision_post_wall = wall

        if should_post_vision and median_n > 0:
            vision_payload = {
                "tree_id": tree_id,
                "timestamp": mapped_timestamp.isoformat(),
                "ai_vision_data": {
                    "health_status": stable_status_tg,
                    "confidence_score": conf_for_api,
                    "camera_image_url": camera_url,
                },
                "action_taken": (
                    "Realtime vision: wilt advisory" if wilted else "Realtime vision: periodic healthy ping (20 min)"
                ),
            }
            ok = post_sensor_data(realtime_vision_url, vision_payload)
            vision_posts += 1 if ok else 0
            print(
                f"📡 [REALTIME VISION] {'OK' if ok else 'FAIL'} {stable_status_tg} {current_stable_health:.1f}% "
                f"({'wilt' if wilted else 'periodic'})"
            )

        frame_h, frame_w = frame.shape[:2]
        image_base64 = encode_frame_base64(frame)
        tracking_payload = {
            "tree_id": tree_id,
            "stream_mode": "realtime_camera",
            "telegram_from_overlay": True,
            "median_window_n": median_n,
            "median_window_max": HEALTH_MEDIAN_WINDOW_SAMPLES,
            "frame_index": frame_index,
            "total_frames": total_frames,
            "video_second": video_second,
            "video_time": video_second,
            "frame_width": frame_w,
            "frame_height": frame_h,
            "polygons": [contour.reshape(-1, 2).astype(int).tolist() for contour in contours_to_draw],
            "axes": [{"pt1": [pt1[0], pt1[1]], "pt2": [pt2[0], pt2[1]], "label": "Target Leaf"} for pt1, pt2 in axes_to_draw],
            "health_status": stable_status_tg,
            "health_percent": round(stable_ui, 2),
            "leaf_area_pixels": int(total_leaf_pixels),
            "health_percent_instant": round(health_percent, 2),
            "health_status_instant": instant_status_vi,
            "calibration_complete": calibration_complete,
            "health_ready_for_stable": health_ready,
            "mapped_timestamp": mapped_timestamp.isoformat(),
            "image_base64": image_base64,
        }
        threading.Thread(target=post_tracking_data, args=(tracking_api_url, tracking_payload), daemon=True).start()

        print(
            f"frame={frame_index} stable_ui={stable_ui:.1f}% instant={health_percent:.1f}%"
            f"({median_n}/{HEALTH_MEDIAN_WINDOW_SAMPLES}) realtime"
        )

    cap.release()
    print(f"Done realtime mode. Vision POST attempts: {vision_posts}.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", default="")
    parser.add_argument("--camera-url", default="http://192.168.1.5:4747/video")
    parser.add_argument("--mode", choices=["demo", "realtime"], default="demo")
    parser.add_argument("--model", default="../models/best.pt")
    parser.add_argument("--demo-ingest-url", default="")
    parser.add_argument("--realtime-vision-url", default="")
    parser.add_argument("--tracking-api-url", required=True)
    parser.add_argument("--tree-id", default="TREE_001")
    parser.add_argument("--send-every-frames", type=int, default=5)
    parser.add_argument("--start-hour", type=int, default=23)
    parser.add_argument("--end-hour", type=int, default=11)
    args = parser.parse_args()

    send_every = max(1, args.send_every_frames)

    if args.mode == "demo":
        video_path = args.video.strip() or str(Path(__file__).resolve().parent.parent / "web" / "public" / "videos" / "final.mp4")
        ingest_url = args.demo_ingest_url.strip()
        if not ingest_url:
            print("Demo mode requires --demo-ingest-url")
            return
        run_demo_mode(
            video_path,
            model_path=args.model,
            demo_ingest_url=ingest_url,
            tracking_api_url=args.tracking_api_url,
            tree_id=args.tree_id,
            send_every_frames=send_every,
            start_hour=args.start_hour,
            end_hour=args.end_hour,
        )
        return

    vision_url_arg = args.realtime_vision_url.strip()
    if not vision_url_arg:
        print("Realtime mode requires --realtime-vision-url")
        return
    cam = args.camera_url.strip()
    run_realtime_mode(
        cam,
        model_path=args.model,
        realtime_vision_url=vision_url_arg,
        tracking_api_url=args.tracking_api_url,
        tree_id=args.tree_id,
        send_every_frames=send_every,
    )


if __name__ == "__main__":
    main()
