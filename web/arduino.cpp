/**
 * VisionComputer — ESP32 Plant IoT Node
 * --------------------------------------
 * Đồng bộ với backend Express ở web/ (route /api/sensors).
 *
 * Vai trò:
 *   1. Đọc độ ẩm đất (analog) + pH (ADC). Nhiệt độ gửi lên server: hằng REPORT_TEMP_C (không cắm DHT).
 *   2. POST telemetry tối giản → backend ghép với AI camera (Python POST /home/api/realtime, không gửi trong body ESP32)
 *      và trả { pump_command: "ON"|"OFF" } theo độ ẩm đất; health_* trong response chỉ để hiển thị.
 *   3. Đóng/mở Rơ-le máy bơm (Active LOW). Nếu mất WiFi/server → fail-safe local theo độ ẩm.
 *
 * Hợp đồng API (khớp web/controllers/home.controller.ts):
 *   POST {SERVER_HOST}/api/sensors (hoặc /home/api/sensors)
 *     Request : { "tree_id":"TREE_001", "soil_moisture":<0..100>, "temperature":<°C> }
 *     Response: { "success":true, "pump_command":"ON|OFF", "health_status":"Healthy|Héo nhẹ|Héo",
 *                 "health_percent":<0..100>, "ai_source":"overlay|db|fallback", ... }
 *
 * Phụ thuộc thư viện (Library Manager):
 *   - "ArduinoJson"  by Benoit Blanchon
 */

 #include <WiFi.h>
 #include <HTTPClient.h>
 #include <ArduinoJson.h>
 // =================== CẤU HÌNH WIFI ===================
 const char* WIFI_SSID     = "Hung";
 const char* WIFI_PASSWORD = "@bang1961";
 
 // =================== CẤU HÌNH SERVER =================
 // IP máy chạy `npm run dev` (cổng mặc định 3000). Đổi theo LAN của bạn.
 // Cùng mạng WiFi với ESP32. Có thể test bằng trình duyệt: http://<IP>:3000/home
 // Trên server: POST từ ESP32 → log [ESP32] ip = 192.168.x.x. GET từ Chrome mở localhost → ip 127.0.0.1 (::1) là UI poll, không phải ESP.
 // pumpSource "ram" chỉ khi ESP đã POST vào đúng tiến trình Node đang chạy (cùng máy, cùng cổng).
 const char* SERVER_HOST     = "http://192.168.1.8:3000";
 const char* SENSOR_PATH     = "/home/api/sensors";       // POST telemetry, nhận lệnh bơm (hoặc "/home/api/sensors")
 const char* LIVE_QUERY_PATH = "/home/api/sensors";       // GET ?after=… (cùng API GET sensor)
 const char* TREE_ID         = "TREE_001";
 
 // =================== CẤU HÌNH PHẦN CỨNG ==============
// =================== CẤU HÌNH PHẦN CỨNG ==============
#define SOIL_PIN   32          // ADC1 — Cảm biến độ ẩm đất [cite: 56]
#define RELAY_PIN  4           // Digital out — Rơ-le bơm (Active LOW) [cite: 55]
#define PH_PIN     33          // Chân nối với lỗ pO của mạch pH [cite: 57]

/** Nhiệt độ gửi trong JSON (không có DHT — backend vẫn nhận trường temperature). */
const float REPORT_TEMP_C = 28.0f;
 // =================== HIỆU CHUẨN CẢM BIẾN pH ========
// 2 thông số hiệu chuẩn thực tế (dung dịch chuẩn):
//   - Ly xanh pH 6.86 đo được 2.80 V
//   - Ly đỏ  pH 4.01 đo được 3.28 V
float voltage_pH6_86 = 2.80;   // Vôn ở dung dịch pH 6.86
float voltage_pH4_01 = 3.28;   // Vôn ở dung dịch pH 4.01
// Hệ số góc đường thẳng (slope): ΔpH / ΔV
float phStep = (6.86 - 4.01) / (voltage_pH6_86 - voltage_pH4_01);  // ≈ −5.9375
 
 // =================== HÀNH VI =========================
 // Live mode: 5s/lần là vừa (12 record/phút) — đủ phản ứng nhanh nhưng không spam DB.
 const unsigned long SAMPLE_INTERVAL_MS = 5000UL;
 
 // --- Độ ẩm đất (ADC 0..4095, GPIO34 = ADC1) ---
 // Bắt buộc hiệu chỉnh 2 điểm từ Serial (xem [SENSOR] raw=...):
 //   SOIL_RAW_AT_DRY  = analogRead khi cảm biến khô / trên không khí.
 //   SOIL_RAW_AT_WET  = analogRead khi nhúng nước / đất bão hòa.
 // Hai số có thể DRY>WET hoặc DRY<WET — map() một dòng vẫn ra 0%=khô, 100%=ướt.
 // Mặc định dưới hay gặp mạch "khô ADC cao, ướt ADC thấp"; nếu nhúng nước mà soil vẫn thấp → đổi
 // SOIL_RAW_AT_WET thành raw thật lúc ngập nước (thường raw cao hơn không khí → DRY<WET).
 const int SOIL_RAW_AT_DRY = 3100;
 const int SOIL_RAW_AT_WET = 1300;
 // Nếu đo được % đúng nhưng server/demo vẫn bật bơm: tắt cứng rơ-le khi đất đọc đủ ướt (an toàn phần cứng).
 const int SOIL_LOCAL_FORCE_PUMP_OFF_FROM = 72;
 
 // Local fail-safe: mất mạng & đất quá khô vẫn chủ động bơm (giống logic backend).
 const int  LOCAL_DRY_PERCENT = 20;
 const unsigned long HTTP_TIMEOUT_MS = 4000UL;
 const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000UL;
 
 // =================== TRẠNG THÁI ======================
 unsigned long lastSampleAt = 0;
 String        lastPumpCmd  = "OFF";
 int           lastSoilPct  = -1;
 
 // ---------------- HELPERS ---------------------------
 void setPump(bool on) {
   digitalWrite(RELAY_PIN, on ? LOW : HIGH); // Active LOW: LOW = bật bơm
 }
 
 /** 9 mẫu + trung vị — ổn định hơn mean khi nhiễu dây/rơ-le. */
 static long medianSoilRaw() {
   long v[9];
   for (int i = 0; i < 9; i++) {
     v[i] = analogRead(SOIL_PIN);
     delay(5);
   }
   for (int a = 0; a < 8; a++) {
     for (int b = a + 1; b < 9; b++) {
       if (v[a] > v[b]) {
         long t = v[a];
         v[a] = v[b];
         v[b] = t;
       }
     }
   }
   return v[4];
 }
 
 int readSoilPercent(long* outRaw) {
   long raw = medianSoilRaw();
   if (outRaw) *outRaw = raw;
   const int d = SOIL_RAW_AT_DRY;
   const int w = SOIL_RAW_AT_WET;
   if (d == w) return 50;
   long pct = map(raw, d, w, 0, 100);
   if (pct < 0)   pct = 0;
   if (pct > 100) pct = 100;
   return (int)pct;
}

static float readTemperatureC() {
  return REPORT_TEMP_C;
}

 bool ensureWifi() {
   if (WiFi.status() == WL_CONNECTED) return true;
   Serial.print("[WiFi] Reconnecting");
   WiFi.disconnect();
   WiFi.mode(WIFI_STA);
   WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
   unsigned long start = millis();
   while (WiFi.status() != WL_CONNECTED) {
     if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
       Serial.println(" — TIMEOUT");
       return false;
     }
     delay(400);
     Serial.print(".");
   }
   Serial.print(" OK  IP=");
   Serial.println(WiFi.localIP());
   return true;
 }
 
 /**
  * POST chỉ gửi đất + nhiệt. Backend trả pump_command (theo đất) và health_* (AI trên server, chỉ để hiển thị).
  * Trả true nếu HTTP 2xx và parse được JSON.
  */
 bool postTelemetry(int soilPct, float tempC, float phValue,
                    String& outCmd, String& outStatus, float& outHealthPct, String& outReason,
                    String& outAiSource, String& outPayload, String& outResp) {
   if (!ensureWifi()) return false;
 
   HTTPClient http;
   String url = String(SERVER_HOST) + SENSOR_PATH;
   http.setTimeout(HTTP_TIMEOUT_MS);
   if (!http.begin(url)) {
     Serial.println("[HTTP] http.begin() failed");
     return false;
   }
   http.addHeader("Content-Type", "application/json");
 
   StaticJsonDocument<200> body;
   body["tree_id"]       = TREE_ID;
   body["soil_moisture"] = soilPct;
   body["temperature"]   = tempC;
   body["ph"]            = phValue;
   serializeJson(body, outPayload);
 
   int code = http.POST(outPayload);
   if (code <= 0) {
     Serial.print("[HTTP] err=");
     Serial.println(http.errorToString(code));
     http.end();
     return false;
   }
 
   outResp = http.getString();
   http.end();
 
   if (code < 200 || code >= 300) return false;
 
   StaticJsonDocument<512> doc;
   DeserializationError err = deserializeJson(doc, outResp);
   if (err) {
     Serial.print("[JSON] parse err=");
     Serial.println(err.c_str());
     return false;
   }
 
   outCmd        = String((const char*)(doc["pump_command"]      | "OFF"));
   outStatus     = String((const char*)(doc["health_status"]     | "Healthy"));
   outHealthPct  = (float)(doc["health_percent"] | 0.0);
   outReason     = String((const char*)(doc["pump_reason"]       | ""));
   outAiSource   = String((const char*)(doc["ai_source"]         | "fallback"));
   return true;
 }
 
 /** Fallback: nếu POST hỏng, thử GET /home/api/sensors (cùng payload latestPumpCommand). */
 bool fetchLatestPumpFromLive(String& outCmd, String& outStatus, float& outHealthPct) {
   if (!ensureWifi()) return false;
   HTTPClient http;
   String url = String(SERVER_HOST) + LIVE_QUERY_PATH;
   http.setTimeout(HTTP_TIMEOUT_MS);
   if (!http.begin(url)) return false;
 
   int code = http.GET();
   if (code <= 0 || code >= 300) {
     Serial.print("[HTTP/live] err code=");
     Serial.println(code);
     http.end();
     return false;
   }
   String resp = http.getString();
   http.end();
 
   StaticJsonDocument<1024> doc;
   if (deserializeJson(doc, resp)) return false;
   outCmd       = String((const char*)(doc["latestPumpCommand"]  | "OFF"));
   outStatus    = String((const char*)(doc["latestHealthStatus"] | "Healthy"));
   outHealthPct = (float)(doc["latestHealthPercent"] | 0.0);
   return true;
 }
 
 // ---------------- SETUP / LOOP -----------------------
 void setup() {
   Serial.begin(115200);
   delay(200);
   Serial.println();
   Serial.println("=== VisionComputer ESP32 Plant Node ===");
 
   pinMode(RELAY_PIN, OUTPUT);
   setPump(false); // tắt bơm khi khởi động cho an toàn
 
   // Đo đủ 0..~3.3V trên ADC1 (nhiều mạch cảm biến cần 11dB).
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
  analogSetPinAttenuation(PH_PIN, ADC_11db);

  ensureWifi();
}
 
 void loop() {
   unsigned long now = millis();
   if (now - lastSampleAt < SAMPLE_INTERVAL_MS) {
     delay(20);
     return;
   }
   lastSampleAt = now;
 
   long  soilRaw = 0;
  int   soilPct = readSoilPercent(&soilRaw);
  float tempC   = readTemperatureC();

    // 1. Đọc pH: lấy trung bình 10 mẫu ADC cho ổn định
    int phRawSum = 0;
    for (int i = 0; i < 10; i++) {
      phRawSum += analogRead(PH_PIN);
      delay(10);
    }
    float phAvgRaw = phRawSum / 10.0;
 
    // 2. Tính điện áp và pH theo công thức hiệu chuẩn 2 điểm
    float phVoltage = phAvgRaw * (3.3 / 4095.0);
    float phValue   = 6.86 + ((phVoltage - voltage_pH6_86) * phStep);
 
    // 3. Ép giới hạn [0, 14]
    if (phValue < 0.0)  phValue = 0.0;
    if (phValue > 14.0) phValue = 14.0;
 
   String cmd       = lastPumpCmd;
   String status    = "Unknown";
   String reason    = "stale";
   float  healthPct = 0;
   String aiSource  = "fallback";
   String payload   = "";
   String resp      = "";
 
   bool ok = postTelemetry(soilPct, tempC, phValue, cmd, status, healthPct, reason, aiSource, payload, resp);
 
   // Luôn hiển thị thông số cảm biến để check phần cứng
   Serial.print("Điện áp pH: ");
   Serial.print(phVoltage);
   Serial.print("V - Chỉ số pH: ");
   Serial.println(phValue);
  Serial.printf("[SENSOR] raw=%ld soil=%d%% temp=%.1f°C (fixed) ph=%.2f wifi=%d\n",
                soilRaw, soilPct, tempC, phValue, WiFi.status());

  if (aiSource == "db" || aiSource == "fallback") {
     Serial.println("[LOG] Đã gửi log sensor lên server (Chưa bật AI/Demo)");
   }
 
   if (!ok) {
     // Thử GET fallback trước khi local override.
     String fbStatus;
     float  fbHealth;
     if (fetchLatestPumpFromLive(cmd, fbStatus, fbHealth)) {
       status    = fbStatus;
       healthPct = fbHealth;
       reason    = "fallback:GET /live";
       ok = true;
     }
   }
 
   // Local fail-safe: server vẫn không cứu được + đất quá khô → bật bơm để khỏi chết cây.
   if (!ok && soilPct < LOCAL_DRY_PERCENT) {
     cmd    = "ON";
     reason = "local-failsafe:soil_dry";
     Serial.println("[FAILSAFE] mất kết nối + đất khô → bật bơm theo logic local.");
   } else if (!ok) {
     cmd    = "OFF";
     reason = "local-failsafe:soil_ok";
     Serial.printf("[FAILSAFE] mất kết nối + đất đủ ẩm (%d%%) → tắt bơm.\n", soilPct);
   }
 
   // Phần cứng: nếu % đất đã cao (ướt) mà lệnh vẫn ON → tắt bơm (tránh map sai / demo server).
   if (cmd == "ON" && soilPct >= SOIL_LOCAL_FORCE_PUMP_OFF_FROM) {
     cmd    = "OFF";
     reason = "local:soil_wet_force_off";
     Serial.printf("[PUMP] local OFF: soil=%d%% >= %d%% (hiệu chỉnh SOIL_RAW_AT_* nếu sai lâu)\n",
                   soilPct, SOIL_LOCAL_FORCE_PUMP_OFF_FROM);
   }
 
   if (cmd != lastPumpCmd) {
     Serial.printf("[PUMP] %s → %s  (reason=%s)\n", lastPumpCmd.c_str(), cmd.c_str(), reason.c_str());
   }
   setPump(cmd == "ON");
   lastPumpCmd = cmd;
   lastSoilPct = soilPct;
 
   if (ok) {
     if (aiSource == "overlay") {
       Serial.printf("[SERVER] pump=%s (%s) | AI từ backend (tham khảo): %s %.1f%%\n",
                     cmd.c_str(),
                     reason.length() ? reason.c_str() : "—",
                     status.c_str(),
                     healthPct);
     } else if (aiSource == "realtime_pending") {
       Serial.print("→ POST ");
       Serial.println(payload);
       Serial.print("← HTTP 2xx  ");
       Serial.println(resp);
     }
   }
 }