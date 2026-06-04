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

**Hệ thống giám sát cây trồng thông minh** kết hợp **cảm biến IoT (ESP32)**, **AI vision (YOLO)**, **backend Node.js + MongoDB**, và **sổ cái phân tán Hyperledger Fabric** để lưu vết dữ liệu **bất biến**.

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


