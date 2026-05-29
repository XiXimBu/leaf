import type { PumpStatus } from "../validations/home.validate";

/** node-wit không ship types — require + ép kiểu để ts-node không báo TS7016. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeWit = require("node-wit") as any;
const Wit = nodeWit.Wit as new (opts: { accessToken: string }) => {
  message: (text: string, opts?: Record<string, unknown>) => Promise<WitMessageResponse>;
};

type WitEntityRow = { value?: string; confidence?: number };

type WitMessageResponse = {
  text?: string;
  intents?: Array<{ name?: string; confidence?: number }>;
  entities?: Record<string, WitEntityRow[]>;
};
// =============================================================================
// Validation — POST /api/voice-command (bơm → home.validate.ts)
// =============================================================================

export type VoicePumpCommand = PumpStatus;

export type VoiceCommandValidated = { message: string };

type VoiceParseFail = {
  ok: false;
  status: number;
  payload: { success: false; error?: string; message?: string };
};

type VoiceParseOk<T> = { ok: true; data: T };

export type VoiceCommandParseResult = VoiceParseOk<VoiceCommandValidated> | VoiceParseFail;

const bodyRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

/** POST /home/api/voice-command — { message: string } */
export function parseVoiceCommandPostBody(raw: unknown): VoiceCommandParseResult {
  const body = bodyRecord(raw);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return {
      ok: false,
      status: 400,
      payload: { success: false, error: "Không nhận được câu lệnh (message)." },
    };
  }
  if (message.length > 500) {
    return {
      ok: false,
      status: 400,
      payload: { success: false, error: "Câu lệnh quá dài (tối đa 500 ký tự)." },
    };
  }
  return { ok: true, data: { message } };
}

// =============================================================================
// Wit.ai + hành động giọng nói
// =============================================================================

export type SensorAskKind = "__ASK_SOIL__" | "__ASK_TEMP__" | "__ASK_PH__";

export type VoiceAction =
  | { type: "pump"; command: VoicePumpCommand; reply: string }
  | { type: "pump_auto"; reply: string }
  | { type: "reply"; reply: string | SensorAskKind }
  | { type: "unknown"; reply: string };

export type LatestIotSnapshot = {
  soilMoisture: number;
  temperature: number;
  ph?: number;
  pumpStatus: VoicePumpCommand;
};

const WIT_ACCESS_TOKEN = process.env.WIT_ACCESS_TOKEN?.trim() || "";
const witClient = WIT_ACCESS_TOKEN ? new Wit({ accessToken: WIT_ACCESS_TOKEN }) : null;

const MIN_INTENT_CONFIDENCE = 0.55;

const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const isSensorAskKind = (v: string): v is SensorAskKind =>
  v === "__ASK_SOIL__" || v === "__ASK_TEMP__" || v === "__ASK_PH__";

const firstEntity = (
  entities: WitMessageResponse["entities"],
  role: string
): string | undefined => {
  if (!entities) return undefined;
  const key = Object.keys(entities).find((k) => k === role || k.startsWith(`${role}:`));
  const row = key ? entities[key]?.[0] : undefined;
  return typeof row?.value === "string" ? row.value : undefined;
};

const topIntent = (
  intents: WitMessageResponse["intents"]
): { name: string; confidence: number } | null => {
  const row = intents?.[0];
  if (!row?.name) return null;
  return { name: row.name, confidence: Number(row.confidence ?? 0) };
};

/** Fallback khi chưa cấu hình Wit hoặc Wit lỗi — khớp chip gợi ý trên UI. */
export const parseVoiceLocal = (message: string): VoiceAction | null => {
  const t = normalizeText(message);
  if (!t) return null;

  if (
    t.includes("tu dong") ||
    t.includes("che do tu dong") ||
    t.includes("auto bom") ||
    t.includes("bom tu dong")
  ) {
    return {
      type: "pump_auto",
      reply: "Chuyển bơm về chế độ tự động theo độ ẩm đất.",
    };
  }

  const hasPump = t.includes("bom") || t.includes("may bom");
  if (hasPump) {
    if (t.includes("tat") || t.includes("dung") || t.includes("off")) {
      return {
        type: "pump",
        command: "OFF",
        reply: "Đã tắt máy bơm theo lệnh giọng nói (ghi đè tự động).",
      };
    }
    if (t.includes("bat") || t.includes("mo") || t.includes("on")) {
      return {
        type: "pump",
        command: "ON",
        reply: "Đã bật máy bơm theo lệnh giọng nói (ghi đè tự động).",
      };
    }
  }

  if (t.includes("do am dat") || t.includes("am dat") || t.includes("do am")) {
    return { type: "reply", reply: "__ASK_SOIL__" };
  }
  if (t.includes("nhiet do") || t.includes("nong do")) {
    return { type: "reply", reply: "__ASK_TEMP__" };
  }
  if (/\bph\b/.test(t) || t.includes("do ph") || t.includes("chi so ph")) {
    return { type: "reply", reply: "__ASK_PH__" };
  }

  if (
    t.includes("bao nhieu") ||
    t.includes("may bao nhieu") ||
    t.includes("chi so") ||
    t.includes("thong so")
  ) {
    if (t.includes("dat") || t.includes("am")) return { type: "reply", reply: "__ASK_SOIL__" };
    if (t.includes("nhiet")) return { type: "reply", reply: "__ASK_TEMP__" };
    if (t.includes("ph")) return { type: "reply", reply: "__ASK_PH__" };
  }

  return null;
};

const actionFromWit = (wit: WitMessageResponse): VoiceAction | null => {
  const intent = topIntent(wit.intents);
  const entities = wit.entities;

  if (!intent || intent.confidence < MIN_INTENT_CONFIDENCE) {
    return null;
  }

  console.log("[DEBUG WIT.AI] Intent:", intent.name, "confidence:", intent.confidence);
  console.log("[DEBUG WIT.AI] Entities:", JSON.stringify(entities, null, 2));

  if (intent.name === "dieu_khien_thiet_bi") {
    const device = firstEntity(entities, "thiet_bi");
    const state = firstEntity(entities, "trang_thai");

    if (device !== "may_bom") return null;

    if (state === "on") {
      return {
        type: "pump",
        command: "ON",
        reply: "Đã bật máy bơm (Wit.ai · chế độ giọng nói).",
      };
    }
    if (state === "off") {
      return {
        type: "pump",
        command: "OFF",
        reply: "Đã tắt máy bơm (Wit.ai · chế độ giọng nói).",
      };
    }
    return null;
  }

  if (intent.name === "xem_thong_so") {
    const device = firstEntity(entities, "thiet_bi");

    if (device === "nhiet_do") return { type: "reply", reply: "__ASK_TEMP__" };
    if (device === "cam_bien_ph") return { type: "reply", reply: "__ASK_PH__" };
    if (device === "do_am_dat") return { type: "reply", reply: "__ASK_SOIL__" };
  }

  return null;
};

export const formatSensorReply = (
  kind: SensorAskKind,
  iot: LatestIotSnapshot | null
): string => {
  if (!iot) {
    return "Chưa có dữ liệu từ ESP32. Hãy bật node IoT và đợi vài giây.";
  }
  if (kind === "__ASK_SOIL__") {
    return `Độ ẩm đất hiện tại là ${iot.soilMoisture} phần trăm. Máy bơm đang ${iot.pumpStatus === "ON" ? "bật" : "tắt"}.`;
  }
  if (kind === "__ASK_TEMP__") {
    return `Nhiệt độ hiện tại là ${iot.temperature} độ C.`;
  }
  const ph = iot.ph !== undefined ? iot.ph.toFixed(2) : "chưa đo";
  return `Độ pH hiện tại là ${ph}.`;
};

/** message đã qua parseVoiceCommandPostBody. */
export const resolveVoiceAction = async (message: string): Promise<VoiceAction> => {
  console.log("[DEBUG VOICE] resolveVoiceAction message:", JSON.stringify(message));

  if (witClient) {
    try {
      console.log("[DEBUG WIT.AI] Gửi lên Wit:", message);
      const wit = await witClient.message(message, {});
      console.log("[DEBUG WIT.AI] Phản hồi đầy đủ:", JSON.stringify(wit, null, 2));

      const fromWit = actionFromWit(wit);
      if (fromWit) {
        console.log("[DEBUG WIT.AI] actionFromWit →", fromWit.type);
        return fromWit;
      }
      console.log("[DEBUG WIT.AI] actionFromWit = null → thử parser local");
    } catch (err) {
      console.error("[Voice] Wit.ai error:", err);
    }
  } else {
    console.warn("[Voice] WIT_ACCESS_TOKEN chưa cấu hình — dùng parser local.");
  }

  const local = parseVoiceLocal(message);
  if (local) {
    console.log("[DEBUG VOICE] parseVoiceLocal →", local.type);
    return local;
  }

  console.log("[DEBUG VOICE] Không hiểu lệnh (Wit + local đều null)");
  return {
    type: "unknown",
    reply:
      "Chưa hiểu lệnh. Thử: «bật máy bơm», «tắt máy bơm», «tự động bơm», «độ ẩm đất là bao nhiêu».",
  };
};

export const replyFromVoiceAction = (
  action: VoiceAction,
  iot: LatestIotSnapshot | null
): string => {
  if (action.type === "reply" && typeof action.reply === "string" && isSensorAskKind(action.reply)) {
    return formatSensorReply(action.reply, iot);
  }
  return action.reply;
};

export const isWitConfigured = (): boolean => Boolean(witClient);
