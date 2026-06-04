import type { HealthStatus } from "../models/sensor.model";

export const HEALTH_STATUSES: HealthStatus[] = ["Héo", "Héo nhẹ", "Healthy"];

// =============================================================================
// Bơm / IoT — dùng chung demo, ESP32, giọng nói (pump.helper chỉ giữ logic)
// =============================================================================

export const PUMP_STATUSES = ["ON", "OFF"] as const;
export type PumpStatus = (typeof PUMP_STATUSES)[number];

const bodyAsRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

/** Chuẩn hóa % độ ẩm đất 0–100 cho logic bơm. */
export function clampSoilMoisturePercent(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  return Math.max(0, Math.min(100, value));
}

export function parsePumpStatus(raw: unknown): PumpStatus | null {
  if (raw === "ON" || raw === "on") return "ON";
  if (raw === "OFF" || raw === "off") return "OFF";
  return null;
}

export type VoicePumpValidated = { command: PumpStatus };

export type VoicePumpParseResult =
  | { ok: true; data: VoicePumpValidated }
  | { ok: false; status: number; payload: { success: false; message: string } };

/** POST /home/api/iot/pump — chỉ khi source === "voice". */
export function parseVoicePumpPostBody(raw: unknown): VoicePumpParseResult {
  const body = bodyAsRecord(raw);
  if (body.source !== "voice") {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message:
          'Chỉ lệnh giọng nói ghi đè bơm. Gửi { "command": "ON"|"OFF", "source": "voice" }.',
      },
    };
  }
  const command = parsePumpStatus(body.command ?? body.pump_command);
  if (!command) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message: 'Body cần { "command": "ON" | "OFF", "source": "voice" }.',
      },
    };
  }
  return { ok: true, data: { command } };
}

export type AdminPumpValidated = { command: PumpStatus };

export type AdminPumpParseResult =
  | { ok: true; data: AdminPumpValidated }
  | { ok: false; status: number; payload: { success: false; message: string } };

/** POST /home/api/iot/pump/manual — điều khiển bơm từ UI admin (quyền cao nhất). */
export function parseAdminPumpPostBody(raw: unknown): AdminPumpParseResult {
  const body = bodyAsRecord(raw);
  if (body.source !== "admin") {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message:
          'Điều khiển admin: { "command": "ON"|"OFF", "source": "admin" } và header X-Pump-Admin-Key.',
      },
    };
  }
  const command = parsePumpStatus(body.command ?? body.pump_command);
  if (!command) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message: 'Body cần { "command": "ON" | "OFF", "source": "admin" }.',
      },
    };
  }
  return { ok: true, data: { command } };
}

function isValidAiVision(
  v: unknown
): v is { health_status: string; confidence_score: number; camera_image_url: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { health_status?: unknown }).health_status === "string" &&
    typeof (v as { confidence_score?: unknown }).confidence_score === "number" &&
    typeof (v as { camera_image_url?: unknown }).camera_image_url === "string"
  );
}

function isValidDemoIot(
  v: unknown
): v is { soil_moisture: number; temperature: number; pump_status: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { soil_moisture?: unknown }).soil_moisture === "number" &&
    typeof (v as { temperature?: unknown }).temperature === "number" &&
    typeof (v as { pump_status?: unknown }).pump_status === "string"
  );
}

export type PostDemoValidated = {
  treeId: string;
  timestamp: string | Date | undefined;
  iotForSave: { soil_moisture: number; temperature: number; pump_status: "ON" | "OFF" };
  aiVision: { health_status: HealthStatus; confidence_score: number; camera_image_url: string };
  action_taken: string;
};

export type PostDemoParseResult =
  | { ok: true; data: PostDemoValidated }
  | { ok: false; status: number; payload: { success: false; message: string } };

/**
 * POST /home/api/demo — video demo: AI + IoT giả (đủ trường), một entry validate.
 */
export function parsePostDemoBody(raw: unknown): PostDemoParseResult {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const treeId =
    typeof body.tree_id === "string" && body.tree_id.trim() ? body.tree_id.trim() : "";
  if (!treeId) {
    return {
      ok: false,
      status: 400,
      payload: { success: false, message: "Field 'tree_id' (string) is required." },
    };
  }

  const { iot_data, ai_vision_data, action_taken } = body;
  const rawTimestamp = body.timestamp;
  const timestamp: string | Date | undefined =
    rawTimestamp === undefined
      ? undefined
      : typeof rawTimestamp === "string" || rawTimestamp instanceof Date
        ? rawTimestamp
        : undefined;
  if (typeof action_taken !== "string" || !isValidAiVision(ai_vision_data)) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message:
          "Demo requires ai_vision_data {health_status, confidence_score, camera_image_url} and action_taken (string).",
      },
    };
  }
  if (!HEALTH_STATUSES.includes(ai_vision_data.health_status as HealthStatus)) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message: `ai_vision_data.health_status must be one of: ${HEALTH_STATUSES.join(", ")}.`,
      },
    };
  }
  if (!isValidDemoIot(iot_data)) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message:
          "Demo requires iot_data {soil_moisture:number, temperature:number, pump_status:string} (simulated from video pipeline).",
      },
    };
  }
  const pumpStatus = parsePumpStatus(iot_data.pump_status);
  if (!pumpStatus) {
    return {
      ok: false,
      status: 400,
      payload: { success: false, message: "iot_data.pump_status must be ON or OFF." },
    };
  }

  const aiStatusTyped = ai_vision_data.health_status as HealthStatus;

  return {
    ok: true,
    data: {
      treeId,
      timestamp,
      iotForSave: {
        soil_moisture: clampSoilMoisturePercent(iot_data.soil_moisture),
        temperature: iot_data.temperature,
        pump_status: pumpStatus,
      },
      aiVision: {
        health_status: aiStatusTyped,
        confidence_score: ai_vision_data.confidence_score,
        camera_image_url: ai_vision_data.camera_image_url,
      },
      action_taken,
    },
  };
}

/** POST /home/api/sensors — chỉ telemetry ESP32 (GET cùng nhóm chỉ đọc DB/RAM). */
export type Esp32SensorsValidated = {
  treeId: string;
  soilMoisture: number;
  temperature: number;
  ph?: number;
};

export type Esp32SensorsParseResult =
  | { ok: true; data: Esp32SensorsValidated }
  | { ok: false; status: number; payload: { success: false; message: string } };

export function parseEsp32SensorsPostBody(raw: unknown): Esp32SensorsParseResult {
  const body = bodyAsRecord(raw);
  if (
    body.ai_vision_data !== undefined ||
    body.iot_data !== undefined ||
    body.action_taken !== undefined
  ) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message:
          "POST /home/api/sensors chỉ nhận telemetry ESP32 { tree_id, soil_moisture, temperature? }. AI (camera) → POST /home/api/realtime. Demo đầy đủ → POST /home/api/demo.",
      },
    };
  }

  const treeId =
    typeof body.tree_id === "string" && body.tree_id.trim() ? body.tree_id.trim() : "";
  if (!treeId) {
    return {
      ok: false,
      status: 400,
      payload: { success: false, message: "Field 'tree_id' (string) is required." },
    };
  }

  const soilMoisture = clampSoilMoisturePercent(Number(body.soil_moisture));
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 28;
  if (!Number.isFinite(soilMoisture)) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message: "ESP32 payload requires at least: { tree_id, soil_moisture (number, 0–100) }.",
      },
    };
  }

  const phRaw = Number(body.ph);
  const ph = Number.isFinite(phRaw) ? Math.max(0, Math.min(14, phRaw)) : undefined;

  return { ok: true, data: { treeId, soilMoisture, temperature, ph } };
}

/** POST /home/api/realtime — chỉ AI vision từ Python (không iot_data). */
export type RealtimeAiValidated = {
  treeId: string;
  timestamp: string | Date | undefined;
  aiVision: { health_status: HealthStatus; confidence_score: number; camera_image_url: string };
  action_taken: string;
};

export type RealtimeAiParseResult =
  | { ok: true; data: RealtimeAiValidated }
  | { ok: false; status: number; payload: { success: false; message: string } };

export function parseRealtimeAiPostBody(raw: unknown): RealtimeAiParseResult {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const treeId =
    typeof body.tree_id === "string" && body.tree_id.trim() ? body.tree_id.trim() : "";
  if (!treeId) {
    return {
      ok: false,
      status: 400,
      payload: { success: false, message: "Field 'tree_id' (string) is required." },
    };
  }

  if (body.iot_data !== undefined) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message:
          "POST /home/api/realtime chỉ nhận AI vision; không gửi iot_data. Telemetry ESP32 → POST /home/api/sensors.",
      },
    };
  }

  const { ai_vision_data, action_taken } = body;
  const rawTimestamp = body.timestamp;
  const timestamp: string | Date | undefined =
    rawTimestamp === undefined
      ? undefined
      : typeof rawTimestamp === "string" || rawTimestamp instanceof Date
        ? rawTimestamp
        : undefined;

  if (typeof action_taken !== "string" || !isValidAiVision(ai_vision_data)) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message:
          "Realtime AI requires ai_vision_data {health_status, confidence_score, camera_image_url} and action_taken (string).",
      },
    };
  }
  if (!HEALTH_STATUSES.includes(ai_vision_data.health_status as HealthStatus)) {
    return {
      ok: false,
      status: 400,
      payload: {
        success: false,
        message: `ai_vision_data.health_status must be one of: ${HEALTH_STATUSES.join(", ")}.`,
      },
    };
  }

  const aiStatusTyped = ai_vision_data.health_status as HealthStatus;

  return {
    ok: true,
    data: {
      treeId,
      timestamp,
      aiVision: {
        health_status: aiStatusTyped,
        confidence_score: ai_vision_data.confidence_score,
        camera_image_url: ai_vision_data.camera_image_url,
      },
      action_taken,
    },
  };
}
