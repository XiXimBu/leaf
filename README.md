# VisionComputer

Hệ thống giám sát cây trồng kết hợp **AI vision (YOLO)** trên video, **backend Node/Express + MongoDB**, và **ESP32** (độ ẩm đất, bơm). Tài liệu dưới đây mô tả **luồng dữ liệu**, **API**, và **khác biệt Demo vs Live**.

---

## Mục lục

1. [Kiến trúc tổng thể](#kiến-trúc-tổng-thể)
2. [Cấu trúc thư mục](#cấu-trúc-thư-mục)
3. [Chạy nhanh (local)](#chạy-nhanh-local)
4. [Luồng: bấm Demo](#luồng-bấm-demo)
5. [Luồng: bấm Realtime (Live)](#luồng-bấm-realtime-live)
6. [ESP32 (`web/arduino.cpp`)](#esp32-webarduinocpp)
7. [API & controller](#api--controller)
8. [Service & MongoDB](#service--mongodb)
9. [Python AI (`cv.engine/video_tracking_stream.py`)](#python-ai-cvenginevideo_tracking_streampy)
10. [Tóm tắt Demo vs Live](#tóm-tắt-demo-vs-live)
11. [Câu hỏi thường gặp](#câu-hỏi-thường-gặp)
12. [Luồng lưu lịch sử Blockchain (Chaincode)](#luồng-lưu-lịch-sử-blockchain-chaincode)

---

## Kiến trúc tổng thể

```text
┌────────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│  Trình duyệt (UI)  │    │  Backend Express     │    │  Python AI Engine  │
│  script.js / Pug   │◄──►│  controllers/        │◄──►│  YOLO + OpenCV     │
│  Chart.js + Canvas │    │  services/ + Mongo   │    │  video_tracking…   │
└────────────────────┘    └──────────┬───────────┘    └────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │  ESP32 (arduino.cpp) │
                          │  Cảm biến + Rơ-le    │
                          └──────────────────────┘
```

| Thành phần | Vai trò |
|------------|---------|
| **Frontend** (`web/public/javascript/script.js`, view Pug) | Vẽ biểu đồ, overlay khung hình, gọi API. |
| **Backend** (`web/controllers/home.controller.ts`, `web/services/home.services.ts`) | Validate request, đọc/ghi MongoDB, **spawn** process Python. |
| **Python** (`cv.engine/video_tracking_stream.py`) | Segment lá (YOLO) → tính sức khỏe → POST overlay + (tùy mode) POST sensor. |
| **ESP32** (`web/arduino.cpp`) | Độc lập: đo đất/nhiệt, POST telemetry, nhận `pump_command` từ server. |

**Lưu ý route:** App mount router tại cả `/` và `/home` (`web/routes/index.routes.ts`), nên URL có thể là `/api/...` hoặc `/home/api/...` tùy cách gọi.

---

## Cấu trúc thư mục

| Đường dẫn | Nội dung |
|-----------|----------|
| `web/` | Express, views Pug, static `public/`, TypeScript entry `index.ts`. |
| `web/controllers/home.controller.ts` | Logic HTTP: sensor, live poll, spawn Python, tracking buffer. |
| `web/services/home.services.ts` | Thao tác MongoDB (Sensor). |
| `web/models/sensor.model.ts` | Schema Mongoose; `iot_data` optional cho bản ghi **AI-only** (live). |
| `cv.engine/` | Venv Python, script `video_tracking_stream.py`, model YOLO. |
| `models/best.pt` | Trọng số YOLO (đường dẫn spawn từ controller). |
| `web/public/videos/final.mp4` | Video demo mặc định. |
| `web/arduino.cpp` | Firmware ESP32 (Arduino IDE / PlatformIO). |

---

## Chạy nhanh (local)

1. **MongoDB** chạy và cấu hình trong `web/.env` (xem `web/config/database.ts`).
2. Trong thư mục `web/`:

   ```bash
   npm install
   npm run dev
   ```

3. Mở trình duyệt: `http://localhost:3000` (hoặc cổng trong `PORT`).
4. **Python:** được gọi tự động khi bấm Demo/Live; ưu tiên `cv.engine/Scripts/python.exe` trên Windows (xem `startRealtimeVideoStream` trong controller).

**Telegram (tùy chọn):** biến môi trường trong `cv.engine/.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

---

## Luồng: bấm Demo

### 1. Frontend (`script.js`)

- Nút **Demo** → `startMode("demo")`.
- Bật polling:
  - **Tracking** mỗi **200 ms** → `GET …/api/sensors/realtime/tracking?afterFrame=…` (overlay + điểm chart từ buffer).
  - **Live** mỗi **500 ms** → trong mode demo, `pollLive()` **thoát sớm**; chart demo chủ yếu từ tracking, không quét DB theo cursor live.
- Gọi:

  ```http
  POST /api/sensors/realtime/start
  Content-Type: application/json

  { "mode": "demo", "cameraUrl": "...", "sendEveryFrames": 2 }
  ```

### 2. Backend — `startRealtimeVideoStream`

- Kill job Python cũ (nếu có), xóa `latestTrackingOverlay` và buffer tracking.
- `videoPath` = `web/public/videos/final.mp4`.
- `spawn` Python với `--mode demo`, `--api-url`, `--tracking-api-url`, `--tree-id`, `--send-every-frames`, `--start-hour 23`, `--end-hour 11`.
- Trả **201** ngay; Python chạy nền.

### 3. Python — demo (`run_stream`)

| Bước | Mô tả |
|------|--------|
| Mở video | `open_video_capture` → `final.mp4`. |
| Timeline ảo | Khoảng 23:00 → 11:00 hôm sau (~12 giờ) trải đều theo số frame. |
| Inference | Mỗi `send_every_frames` frame: YOLO → diện tích lá → `%` so baseline vài giây đầu. |
| Health demo | `current_stable_health` = `_demo_simulated_health(progress)` (cosine 100% → 60% → 100%), **không** dùng median đo thật cho DB/Telegram ở demo. |
| IoT trong payload demo | `_vision_iot_derived(health)` suy `soil_moisture`, `temperature`, `pump_status` — **giả lập có quy tắc**, không random. |

**Hai luồng POST:**

| Luồng | Endpoint | Tần suất / ghi chú |
|--------|----------|---------------------|
| Overlay | `POST …/realtime/tracking` | Theo frame xử lý (nhanh); **không** lưu Mongo. |
| Sensor | `POST …/api/sensors` | Throttle theo **~1 giờ ảo** trên timeline + frame cuối; giảm số bản ghi (blockchain/DB). |

### 4. Backend nhận dữ liệu

- `postRealtimeTrackingOverlay` → cập nhật `latestTrackingOverlay`, buffer tối đa ~600 mục.
- `postSensorData` → validate → `saveSensorData` → Mongo.

### 5. Telegram (Python)

- Báo định kỳ ~15 s; cảnh báo khi health ổn định &lt; 85% (theo demo curve).

---

## Luồng: bấm Realtime (Live)

### 1. Frontend

- `startMode("live")` — cùng `POST /realtime/start` nhưng `mode: "live"`.
- **`pollLive()` không thoát sớm:** `GET …/api/sensors/live?after=…` để đồng bộ chart + dòng trạng thái (pump, đất ESP32, AI).

### 2. Backend spawn

- `videoPath` = URL camera (mặc định ví dụ DroidCam `http://192.168.1.2:4747/video`).
- Python `--mode live`.

### 3. Python — live

| Khía cạnh | Demo | Live |
|-----------|------|------|
| Nguồn | File MP4 | Luồng HTTP/camera |
| `mapped_timestamp` | Giờ ảo theo video | **Giờ máy chủ** |
| Health lưu DB / Telegram | Cosine giả lập | **Median đo thật** (cửa sổ mẫu) |
| `iot_data` trong POST sensor | Có (suy từ health) | **Không** — **AI-only**; IoT thật do ESP32 |
| Throttle DB sensor | Theo “giờ ảo” | Theo `DB_SAVE_INTERVAL_MINUTES` (wall-clock) |

Overlay vẫn POST như demo; sensor record chỉ còn `tree_id`, `timestamp`, `ai_vision_data`, `action_taken` (không field `iot_data`).

### 4. `getLiveSensorData`

- `data[]`: bản ghi mới theo `createdAt` (có thể xen **AI-only** và **ESP32**).
- `latestPumpCommand`, `latestSoilMoisture`, `latestTemperature`: từ **bản ghi IoT mới nhất** (`getLatestIotRecord`), bỏ qua bản ghi không có `iot_data`.
- Trạng thái AI mới nhất: overlay in-memory hoặc fallback DB.

---

## ESP32 (`web/arduino.cpp`)

Chu kỳ ~**5 giây** trong `loop()`:

1. Đọc độ ẩm (ADC, map calibration) + nhiệt độ (DHT tùy chọn).
2. `POST {SERVER}/home/api/sensors` với body tối giản:

   ```json
   { "tree_id": "TREE_001", "soil_moisture": 23, "temperature": 28.5 }
   ```

3. Đọc JSON response: `pump_command`, `health_status`, …
4. Điều khiển rơ-le (**Active LOW**).
5. **Fail-safe:** POST lỗi → thử `GET …/api/sensors/live`; vẫn lỗi + đất quá khô → bật bơm local.

Cấu hình: `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_HOST` (IP máy chạy `npm run dev`).

---

## API & controller

File: `web/controllers/home.controller.ts`

| Hàm | HTTP | Vai trò |
|-----|------|---------|
| `getHome` | `GET /` hoặc `/home/` | Render trang chủ, chart SSR. |
| `postSensorData` | `POST /api/sensors` | **Nhánh A:** Python — có `ai_vision_data`, `iot_data` tùy chọn (live = không gửi IoT). **Nhánh B:** ESP32 — `soil_moisture` (+ `temperature`). Trả `pump_command`. |
| `getLiveSensorData` | `GET /api/sensors/live` | Cursor + snapshot pump/soil/AI cho chart và ESP32 fallback. |
| `startRealtimeVideoStream` | `POST /api/sensors/realtime/start` | Spawn Python demo/live. |
| `postRealtimeTrackingOverlay` | `POST …/realtime/tracking` | Buffer overlay (RAM), không Mongo. |
| `getRealtimeTrackingOverlay` | `GET …/realtime/tracking` | Frontend poll theo `afterFrame`. |
| `getLatestAiSnapshot` | (nội bộ) | AI: overlay → DB → mặc định Healthy. |
| `decidePumpCommand` | (nội bộ) | `soil < 25%` → ON; else theo AI Healthy/OFF. |

---

## Service & MongoDB

File: `web/services/home.services.ts`

| Hàm | Vai trò |
|-----|---------|
| `saveSensorData` | `Sensor.create` — chỉ ghi `iot_data` nếu có (AI-only bỏ field). |
| `saveSensorDataBulk` | Insert nhiều bản ghi (dự phòng). |
| `getRecentSensorData` | N bản ghi mới theo `timestamp` (SSR chart). |
| `getSensorDataAfter` | Polling live theo `createdAt`. |
| `getLatestIotRecord` | Bản ghi có `iot_data` mới nhất (snapshot IoT thật). |

---

## Python AI (`cv.engine/video_tracking_stream.py`)

| Hàm | Vai trò |
|-----|---------|
| `main` | `argparse`, gọi `run_stream`. |
| `run_stream` | Vòng đọc frame, YOLO, health, POST tracking + POST sensor (điều kiện). |
| `open_video_capture` | File hoặc URL camera; thử vài biến thể path. |
| `_vision_iot_derived` | Từ `%` health → status, confidence, soil/temp/pump **suy luận** (dùng cho **demo** và instant trong code). |
| `_demo_simulated_health` | Đường cong cosine cho demo. |
| `health_status_vi` | Ngưỡng Héo / Héo nhẹ / Healthy. |
| `post_sensor_data` / `post_tracking_data` | HTTP POST JSON. |
| `encode_frame_base64` | Frame → JPEG base64 cho overlay. |

---

## Tóm tắt Demo vs Live

| | **Demo** | **Realtime (Live)** |
|---|----------|----------------------|
| Video | `final.mp4` | Camera / URL |
| Health trong DB/Telegram | Cosine (minh hoạ đủ trạng thái) | Đo thật (median) |
| `iot_data` khi Python lưu DB | Có (suy từ health curve) | **Không** (ESP32 chịu trách nhiệm IoT) |
| Chart chính | Tracking poll | Tracking + **live** poll DB |
| ESP32 | Có thể chạy song song, không bắt buộc cho demo UI | Nên có để có soil/pump thật |

---

## Câu hỏi thường gặp

**Bấm Demo thì chuyện gì xảy ra?**  
Frontend gọi `POST …/realtime/start` với `mode: demo` → backend spawn Python đọc `final.mp4` → Python gửi overlay liên tục và ghi DB sensor **thưa** (theo “giờ ảo”) với **IoT suy từ curve** → UI chủ yếu poll **tracking**. ESP32 nếu đang bật vẫn POST riêng, không cần cho màn demo.

**Bấm Realtime thì sao?**  
Cùng endpoint start nhưng `mode: live` → Python đọc camera, lưu DB **AI-only** (không `iot_data` giả) → ESP32 gửi soil/temp định kỳ → backend **ghép** AI mới nhất + đất để trả `pump_command` → UI poll **tracking + live**.

---

## 12. Luồng lưu lịch sử Blockchain (Chaincode)

Hệ thống ghi nhận dữ liệu cảm biến và AI song song xuống cả MongoDB và Sổ cái (Ledger) của Hyperledger Fabric Blockchain thông qua Gateway và Chaincode. Quá trình này diễn ra như sau:

### 1. Web Backend (`web/services/home.services.ts`)
- Mỗi khi có một bản ghi `TreeSnapshot` mới được lưu thành công vào MongoDB (thông qua hàm `saveTreeSnapshot` hoặc `saveDemoVideoTreeSnapshot`), backend sẽ gọi thêm hàm `sendToBlockchain(doc)`.
- Hàm `sendToBlockchain` tạo một HTTP POST request gửi dữ liệu JSON này đến Application Gateway của blockchain tại địa chỉ `http://localhost:8080/api/blockchain/record`.

### 2. Application Gateway (`blockchain/blockchain-leaf/application.gateway/app.ts`)
- Đóng vai trò là cầu nối giữa Web Backend và mạng Hyperledger Fabric thông qua gRPC.
- Mở một server Express chạy ở port 8080.
- Khi nhận yêu cầu **POST `/api/blockchain/record`**: Nó trích xuất `tree_id` làm định danh (`id`), và chuyển đổi toàn bộ payload thành chuỗi (string). Sau đó, nó đệ trình một giao dịch lên mạng bằng lệnh `contract.submitTransaction('CreateRecord', id, payloadStr)`.
- Khi nhận yêu cầu **GET `/api/blockchain/history/:id`**: Nó truy vấn (`evaluateTransaction`) gọi hàm `GetHistory` trên chaincode để lấy toàn bộ lịch sử biến động theo `tree_id`.

### 3. Smart Contract / Chaincode (`blockchain/blockchain-leaf/chaincode/index.ts`)
- Chứa logic cốt lõi thực thi trên các Node của mạng Blockchain.
- **`CreateRecord`**: Nhận dữ liệu text từ Gateway, parse thành object JSON, gán thuộc tính `docType = 'tree_snapshot'` và cập nhật `id`. Ghi dữ liệu vào trạng thái mới nhất (World State) thông qua `ctx.stub.putState(id, data)`. Khi thực hiện lưu liên tục vào cùng một khóa (`id`), nền tảng Fabric tự động cấu trúc để lưu lại lịch sử các lần thay đổi này trên chuỗi khối (Ledger).
- **`GetHistory`**: Sử dụng hàm cấp thấp `ctx.stub.getHistoryForKey(id)` để trích xuất ra toàn bộ lịch sử (từ block ban đầu đến mới nhất) của khóa `id`. Dữ liệu lịch sử bao gồm: `block_timestamp` (thời điểm ghi block), `txid` (mã định danh giao dịch), và `data` (dữ liệu payload gốc được lưu). Điều này giúp tra cứu ngược vòng đời cây trồng minh bạch.

---

*Tài liệu này phản ánh kiến trúc hiện tại của repo; khi đổi route hoặc hằng số (ngưỡng soil, interval), cập nhật tương ứng trong code và README.*
