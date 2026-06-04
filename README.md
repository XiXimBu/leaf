<div align="center">
  <h3>🎓 Faculty of Information Technology (DaiNam University)</h3>
  <h2>BLOCKCHAIN TECHNOLOGY</h2>
  <table>
    <tr>
      <td align="center"><img src="docs/poster/aiotlab_logo.png" width="200" /></td>
      <td align="center"><img src="docs/poster/fitdnu_logo.png" width="200" /></td>
      <td align="center"><img src="docs/poster/dnu_logo.png" width="200" /></td>
    </tr>
  </table>
</div>

# VisionComputer

**VisionComputer** là một giải pháp giám sát và quản lý cây trồng thông minh tự động hóa, ứng dụng công nghệ IoT (ESP32) để theo dõi thông số đất và điều khiển bơm, kết hợp AI Vision (YOLO) phân tích sức khỏe lá qua camera theo thời gian thực. Toàn bộ quá trình vận hành được quản lý trên nền tảng web trực quan (Node.js + MongoDB), cho phép người dùng giám sát và điều khiển dễ dàng, bao gồm cả tính năng ra lệnh bằng giọng nói. Nhằm đảm bảo tính minh bạch, toàn vẹn và chống gian lận dữ liệu, lịch sử phát triển của cây trồng liên tục được đồng bộ lên mạng lưới chuỗi khối Hyperledger Fabric. Hệ thống tạo ra một quy trình khép kín từ khâu thu thập thông tin, tự động ra quyết định tưới tiêu, đến lưu trữ bằng chứng lịch sử bất biến phục vụ truy xuất nguồn gốc.

## Tổng quan hệ thống

VisionComputer theo dõi **một cây (tree_id)** qua hai luồng song song:

| Luồng | Mục đích | Lưu trữ chính |
|-------|----------|----------------|
| **Vận hành realtime** | Đo đất, bơm, AI camera, biểu đồ | MongoDB + RAM |
| **Chứng minh / audit** | Không sửa được quá khứ trên chuỗi | Hyperledger Ledger |

```text
                    ┌─────────────────────────────────────────────────────────┐
                    │                    PHẦN 1 — VẬN HÀNH                   │
                    └─────────────────────────────────────────────────────────┘

   ESP32                    Express (web/)                 Python (cv.engine/)
  đất·pH·bơm  ──POST──►  controllers + MongoDB  ◄──spawn──  YOLO + OpenCV
       ▲                         │  │
       │                         │  └──► Telegram (tùy chọn)
       └── pump_command          │
                                 ▼
                          Trình duyệt (Pug + Chart.js)
                          Demo / Live · Admin bơm · Giọng nói

                    ┌─────────────────────────────────────────────────────────┐
                    │              PHẦN 2 — BLOCKCHAIN (AUDIT)               │
                    └─────────────────────────────────────────────────────────┘

   MongoDB (có thể sửa)  ──POST snapshot──►  Gateway :8080  ──gRPC──►  Fabric Peer
                                                      │                      │
                                                      │                      ▼
                                              UI kiểm tra (public/)    Chaincode `agri`
                                              lịch sử · hash · cảnh báo   Ledger bất biến
```



---

## Phần 1 — IoT, AI Vision & Web

### Thành phần

| Thành phần | Đường dẫn | Vai trò |
|------------|-----------|---------|
| **ESP32** | `web/arduino.cpp` | Độ ẩm đất, pH, rơ-le bơm; POST telemetry ~5s |
| **Backend** | `web/` | API, logic bơm (25%→60%), spawn Python |
| **AI Engine** | `visioncomputer/video_tracking_stream.py` | YOLO segment lá → % sức khỏe |
| **Frontend** | `web/views/`, `web/public/javascript/script.js` | Video overlay, chart, admin bơm |

### Sơ đồ luồng (Phần 1)

```mermaid
flowchart LR
  subgraph IoT
    ESP[ESP32]
  end
  subgraph Server
    API[Express API]
    RAM[RAM pendingIot / AI]
    DB[(MongoDB)]
  end
  subgraph Vision
    PY[Python YOLO]
  end
  subgraph UI
    WEB[Trình duyệt]
  end

  ESP -->|POST /api/sensors| API
  API -->|pump_command| ESP
  PY -->|POST /api/realtime| API
  PY -->|POST /api/stream/overlay| API
  API --> RAM
  API -->|định kỳ| DB
  WEB -->|GET /api/sensors| API
  WEB -->|POST stream start| API
  API -->|spawn| PY
```

**Bơm tự động (hysteresis):** bật khi đất **&lt; 25%**; khi đang bơm chỉ tắt khi **≥ 60%**. Admin UI và giọng nói ghi đè lên logic này.


---

## Phần 2 — Blockchain (Hyperledger Fabric)

Thư mục gốc: **`blockchain/blockchain-leaf/`**

```text
blockchain/blockchain-leaf/
├── chaincode/                    # Smart contract (TypeScript → deploy lên Fabric)
│   └── index.ts                  # CreateRecord, GetHistory
├── application.gateway/          # Cầu nối HTTP ↔ Fabric (port 8080)
│   ├── app.ts                    # Express + Fabric Gateway SDK
│   └── public/                   # UI kiểm tra toàn vẹn & lịch sử
│       ├── index.html
│       ├── scripts.js
│       └── style.css
└── test-network/                 # (sau khi khởi tạo) crypto, peer, orderer
```

### Vai trò từng lớp

| Lớp | File | Chức năng |
|-----|------|-----------|
| **Chaincode** | `chaincode/index.ts` | `CreateRecord(id, json)` ghi World State; `GetHistory(id)` đọc **toàn bộ lịch sử** thay đổi khóa `id` trên Ledger |
| **Application Gateway** | `application.gateway/app.ts` | REST API cho web backend và UI demo |
| **Web Backend** | `web/services/home.services.ts` | Sau mỗi lần lưu MongoDB → `POST http://localhost:8080/api/blockchain/record` |
| **UI Blockchain** | `application.gateway/public/` | So sánh DB vs chain, xem timeline, SHA-256 |

### Sơ đồ luồng (Phần 2)

```mermaid
sequenceDiagram
  participant PY as Python / ESP32 / API
  participant WEB as web/services
  participant MONGO as MongoDB
  participant GW as Gateway :8080
  participant CC as Chaincode agri
  participant LEDGER as Fabric Ledger

  PY->>WEB: saveTreeSnapshot / saveDemo...
  WEB->>MONGO: TreeSnapshot.create
  WEB->>GW: POST /api/blockchain/record { tree_id, iot_data, ai_vision_data, ... }
  GW->>CC: submitTransaction CreateRecord
  CC->>LEDGER: putState(tree_id) + append history
  GW-->>WEB: 201 success

  Note over GW,LEDGER: Tra cứu (không sửa được quá khứ)
  participant UI as public/index.html
  UI->>GW: GET /api/blockchain/history/TREE_001
  GW->>CC: evaluateTransaction GetHistory
  CC->>LEDGER: getHistoryForKey
  CC-->>GW: [{ txid, block_timestamp, data }, ...]
  GW-->>UI: JSON timeline
```

### API Gateway (port **8080**)

| Method | Endpoint | Mô tả |
|--------|----------|--------|
| `POST` | `/api/blockchain/record` | Ghi snapshot JSON (bắt buộc `tree_id`) lên chain |
| `GET` | `/api/blockchain/history/:id` | Lấy lịch sử mọi phiên bản của `tree_id` |

**Chaincode** (`AgriContract`):

- **`CreateRecord(ctx, id, recordJsonString)`** — parse JSON, `putState(id, payload)`. Cùng `id` ghi nhiều lần → Fabric lưu **chuỗi phiên bản** trên Ledger (không ghi đè im lặng lịch sử).
- **`GetHistory(ctx, id)`** — `getHistoryForKey(id)` → mỗi mục gồm `txid`, `block_timestamp`, `data` (payload gốc).

### Đồng bộ với MongoDB

Khi `saveTreeSnapshot` hoặc `saveDemoVideoTreeSnapshot` thành công:

```typescript
// web/services/home.services.ts
sendToBlockchain(doc) → POST http://localhost:8080/api/blockchain/record
```

Payload gần với document Mongo (không gửi `__v`, `createdAt` từ phía chain — UI gateway có bước **chuẩn hóa** khi so sánh).

**Lưu ý poster:** MongoDB = **có thể chỉnh sửa** (vận hành). Blockchain = **bằng chứng tham chiếu** — nếu DB bị sửa tay, công cụ so sánh sẽ báo lệch.



---

## Tính bất biến & demo toàn vẹn dữ liệu

### Khái niệm (cho poster)

| Thuật ngữ | Trong VisionComputer |
|-----------|----------------------|
| **Bất biến (immutability)** | Mỗi lần ghi `CreateRecord` tạo **transaction mới** trên Ledger; lịch sử cũ **không xóa** khi cập nhật `tree_id` |
| **Toàn vẹn (integrity)** | UI so sánh JSON hiện tại trong DB với **bản mới nhất trên chain**; khác → cảnh báo |
| **Truy vết (audit trail)** | `GetHistory` trả về timeline: `txid`, thời gian block, payload từng thời điểm |

### Demo trên UI `http://localhost:8080`

Mở **`blockchain/blockchain-leaf/application.gateway/public/index.html`** (qua Gateway đang chạy):

- **Kiểm tra toàn vẹn** — dán JSON “giả lập DB”, bấm *Kiểm tra ngay* → khớp / không khớp với chain.
- **Xem lịch sử** — nhập `TREE_001` → *Tải lịch sử* → thấy nhiều block/tx theo thời gian (**bằng chứng bất biến**).
- **SHA-256** — tính hash payload, ghi chain, đối chiếu lại với lịch sử.

### Kịch bản chụp ảnh thể hiện bất biến

| Bước | Việc làm | Ảnh poster |
|------|----------|------------|
| A | Chạy hệ thống, để vài snapshot lưu Mongo + chain | `blockchain-lich-su.png` — timeline nhiều `txid` |
| B | *Lấy bản mới nhất từ blockchain* → điền vào ô DB → *Kiểm tra* → **Khớp** | `blockchain-khop.png` |
| C | Sửa tay một field trong ô DB (vd. `soil_moisture`) → *Kiểm tra* → **Cảnh báo đỏ** | `blockchain-canh-bao.png` — overlay “DỮ LIỆU ĐÃ BỊ CHỈNH SỬA…” |
| D | (Tuỳ chọn) Tính SHA-256, ghi và đối chiếu | `blockchain-hash.png` |

![Lịch sử blockchain — nhiều transaction cho cùng tree_id](docs/poster/blockchain-lich-su.png)

![So sánh khớp — DB trùng chain](docs/poster/blockchain-khop.png)

![Cảnh báo toàn vẹn — DB khác chain (bất biến làm lộ chỉnh sửa)](docs/poster/blockchain-canh-bao.png)

![SHA-256 Hash](docs/poster/blockchain-hash.png)



---

## Hướng phát triển

Để hoàn thiện và đưa **VisionComputer** vào ứng dụng thực tế trên quy mô lớn, hệ thống có tiềm năng mở rộng theo các hướng sau:

1. **Mở rộng năng lực AI (Edge AI & Đa dạng bệnh lý):**
   - Huấn luyện mô hình YOLO nhận diện chi tiết từng loại bệnh cụ thể (nấm, sâu bọ, thiếu hụt dinh dưỡng) thay vì chỉ phân đoạn và đánh giá sức khỏe tổng thể.
   - Tối ưu hóa mô hình AI để triển khai trực tiếp lên các thiết bị Edge (như NVIDIA Jetson Nano, Raspberry Pi) nhằm giảm độ trễ và xử lý tại biên.

2. **Nâng cấp hệ sinh thái IoT & Tự động hóa:**
   - Tích hợp thêm cảm biến (nhiệt độ, độ ẩm không khí, ánh sáng, chỉ số NPK) và thiết bị châm phân tự động để tạo quy trình canh tác khép kín.
   - Chuyển đổi kiến trúc từ quản lý cây đơn lẻ sang mạng lưới nhiều node cảm biến (Mesh Network) phục vụ diện tích trang trại rộng lớn.

3. **Tối ưu Blockchain & Truy xuất nguồn gốc:**
   - Tích hợp hệ thống lưu trữ phi tập trung (IPFS) để lưu trữ vĩnh viễn các hình ảnh minh chứng từ camera, kết hợp ghi băm (hash) lên Fabric nhằm đảm bảo độ tin cậy tuyệt đối.
   - Phát triển tính năng truy xuất nguồn gốc (Farm-to-Fork) qua mã QR, giúp người tiêu dùng có thể quét và xem toàn bộ lịch sử sinh trưởng bất biến của nông sản.

4. **Trải nghiệm người dùng & AI Assistant:**
   - Nâng cấp tính năng ra lệnh bằng giọng nói bằng cách tích hợp mô hình ngôn ngữ lớn (LLM), giúp trợ lý ảo có khả năng tư vấn nông nghiệp và hỏi đáp ngữ cảnh tự nhiên.
   - Phát triển ứng dụng di động (Mobile App) đa nền tảng để theo dõi, quản lý trang trại từ xa và nhận thông báo đẩy (push notifications).

---

## Cấu trúc thư mục

```text
VisionComputer/
├── README.md                 # Tài liệu này
├── docs/poster/              # Ảnh chèn poster (PNG/JPG)
├── web/                      # Backend + frontend + arduino.cpp
├── visioncomputer/           # Python AI (YOLO)
├── models/                   # best.pt (YOLO weights)
└── blockchain/blockchain-leaf/
    ├── chaincode/
    ├── application.gateway/
    └── test-network/         # Fabric network (sau setup)
```


