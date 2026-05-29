import { Request, Response } from "express";
import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import path from "path";
import type { AiVisionData, HealthStatus, IotData } from "../models/sensor.model";
import * as sendAlert from "../helpers/send.alert";
import homeService from "../services/home.services";
import {
  HEALTH_STATUSES,
  parseEsp32SensorsPostBody,
  parsePostDemoBody,
  parseRealtimeAiPostBody,
  parseVoicePumpPostBody,
  type PumpStatus,
} from "../validations/home.validate";
import {
  applyVoicePumpOverride,
  decidePumpCommand,
  ESP32_DRY_THRESHOLD_PERCENT,
  pumpCommandForEsp32WithDemoPolicy,
  VOICE_PUMP_REASON,
  type PumpCommandResult,
  type VoicePumpOverride,
} from "../helpers/pump.helper";
import {
  isWitConfigured,
  parseVoiceCommandPostBody,
  replyFromVoiceAction,
  resolveVoiceAction,
} from "../helpers/voice.helper";

// =============================================================================
// Telegram (RAM theo tree_id)
// =============================================================================
const demoTelegramStateByTreeId = new Map<string, sendAlert.DemoTelegramTreeState>();
const realtimeTrackingTelegramByTreeId = new Map<string, sendAlert.RealtimeTrackingTelegramState>();

const getDemoTelegramState = (treeId: string): sendAlert.DemoTelegramTreeState => {
  let s = demoTelegramStateByTreeId.get(treeId);
  if (!s) {
    s = sendAlert.createDemoTelegramTreeState();
    demoTelegramStateByTreeId.set(treeId, s);
  }
  return s;
};

const scheduleDemoIngestTelegram = (opts: {
  treeId: string;
  healthPercent: number;
  healthStatus: HealthStatus;
  pumpStatus: "ON" | "OFF";
  soilMoisture: number;
}): void => {
  void sendAlert
    .notifyAfterDemoIngestAlerts({
      state: getDemoTelegramState(opts.treeId),
      treeId: opts.treeId,
      healthPercent: opts.healthPercent,
      healthStatus: opts.healthStatus,
      pumpStatus: opts.pumpStatus,
      soilMoisture: opts.soilMoisture,
    })
    .catch((err) => console.error("[telegram] demo ingest:", err));
};

const getRealtimeTrackingTelegramState = (treeId: string): sendAlert.RealtimeTrackingTelegramState => {
  let s = realtimeTrackingTelegramByTreeId.get(treeId);
  if (!s) {
    s = sendAlert.createRealtimeTrackingTelegramState();
    realtimeTrackingTelegramByTreeId.set(treeId, s);
  }
  return s;
};

// =============================================================================
// Live snapshot → DB (consolidator + POST /realtime) — types / hằng / state
// =============================================================================
type PendingAi = {
  status: HealthStatus;
  healthPct: number;
  cameraImageUrl: string;
  updatedAt: number;
};

type PendingIot = {
  soilMoisture: number;
  temperature: number;
  ph?: number;
  pumpStatus: "ON" | "OFF";
  updatedAt: number;
};

const LIVE_DB_INTERVAL_MINUTES = 60;
const LIVE_DB_INTERVAL_MS = LIVE_DB_INTERVAL_MINUTES * 60 * 1000;
const REALTIME_VISION_DB_INTERVAL_MS = 20 * 60 * 1000;

let lastRealtimeVisionDbAt = 0;
let pendingAi: PendingAi | null = null;
let pendingIot: PendingIot | null = null;
let lastConsolidatedSaveAt = 0; // 0 = chưa lưu → POST đầu tiên trigger save ngay.
/** Chỉ wit.ai / lệnh giọng nói — bỏ qua logic đất cho đến khi DELETE /api/iot/pump-override. */
let voicePumpOverride: VoicePumpOverride = null;

const applyVoiceOverrideIfAny = (pump: PumpCommandResult): PumpCommandResult =>
  applyVoicePumpOverride(pump, voicePumpOverride);

const stopPythonStreamJob = (): void => {
  if (activeRealtimeJob) {
    try {
      activeRealtimeJob.kill("SIGTERM");
    } catch {
      activeRealtimeJob.kill();
    }
    activeRealtimeJob = null;
  }
  activePythonStreamMode = null;
  latestTrackingOverlay = null;
  trackingOverlayBuffer = [];
  resetConsolidatorState();
  resetRealtimeVisionThrottle();
};

const iotDataFromRam = (iot: PendingIot | null): IotData | undefined => {
  if (!iot) return undefined;
  const d: IotData = {
    soil_moisture: iot.soilMoisture,
    temperature: iot.temperature,
    pump_status: iot.pumpStatus,
  };
  if (iot.ph !== undefined) d.ph = iot.ph;
  return d;
};

const saveLiveTreeSnapshot = async (args: {
  treeId: string;
  timestamp?: string | Date;
  aiVision: AiVisionData;
  actionTaken: string;
  ramIot: PendingIot | null;
}): Promise<void> => {
  await homeService.saveTreeSnapshot({
    tree_id: args.treeId,
    timestamp: args.timestamp,
    ai_vision_data: args.aiVision,
    iot_data: iotDataFromRam(args.ramIot),
    action_taken: args.actionTaken,
  });
};


const resetConsolidatorState = (): void => {
  pendingAi = null;
  pendingIot = null;
  lastConsolidatedSaveAt = 0;
};

const resetRealtimeVisionThrottle = (): void => {
  lastRealtimeVisionDbAt = 0;
};

// =============================================================================
// Overlay buffer (Python) — types / hằng / state + POST|GET
// =============================================================================
type DemoIotSnapshot = {
  soil_moisture: number;
  temperature: number;
  ph?: number;
  pump_status: string;
};

type TrackingOverlay = {
  tree_id?: string;
  /** Python: demo_video = IoT giả + AI điều khiển câu chuyện demo; realtime_camera = chỉ AI lá, đất thật từ ESP32. */
  stream_mode?: "demo_video" | "realtime_camera";
  demo_iot?: DemoIotSnapshot;
  calibration_complete?: boolean;
  health_ready_for_stable?: boolean;
  telegram_from_overlay?: boolean;
  median_window_n?: number;
  median_window_max?: number;
  frame_index: number;
  total_frames: number;
  video_second: number;
  video_time?: number;
  /** ISO thời điểm “câu chuyện” (demo timelapse) hoặc thời điểm server (live) — dùng làm trục X biểu đồ. */
  mapped_timestamp?: string;
  frame_width: number;
  frame_height: number;
  polygons: number[][][];
  axes: Array<{ pt1: [number, number]; pt2: [number, number]; label: string }>;
  image_base64?: string;
  /** Trạng thái / % theo trung vị (lưu DB gần như chỉ tiêu này). */
  health_status: string;
  health_percent: number;
  /** Diện tích mask lá khung hiện tại (pixel). */
  leaf_area_pixels?: number;
  /** % sức khỏe khung hiện tại (so baseline), đồng bộ nhìn thấy cây đổ. */
  health_percent_instant?: number;
  health_status_instant?: string;
  updated_at: string;
};

const OVERLAY_BUFFER_MAX = 600;
let latestTrackingOverlay: TrackingOverlay | null = null;
let trackingOverlayBuffer: TrackingOverlay[] = [];
let activePythonStreamMode: "demo" | "realtime" | null = null;
let activeRealtimeJob: ChildProcess | null = null;

const readDemoIotFromBody = (body: Record<string, unknown>): DemoIotSnapshot | undefined => {
  const raw = body.demo_iot;
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const soil = Number(o.soil_moisture);
  const temp = Number(o.temperature);
  const pump = o.pump_status;
  const phRaw = Number(o.ph);
  if (!Number.isFinite(soil) || typeof pump !== "string") return undefined;
  const snap: DemoIotSnapshot = {
    soil_moisture: soil,
    temperature: Number.isFinite(temp) ? temp : 28,
    pump_status: pump,
  };
  if (Number.isFinite(phRaw)) snap.ph = Math.max(0, Math.min(14, phRaw));
  return snap;
};

const postRealtimeTrackingOverlay = async (req: Request, res: Response): Promise<void> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const treeIdOverlay =
    typeof body.tree_id === "string" && body.tree_id.trim() ? body.tree_id.trim() : undefined;
  const telegramFromCvOverlay = body.telegram_from_overlay === true;
  const streamRaw = body.stream_mode;
  const stream_mode =
    streamRaw === "demo_video" || streamRaw === "realtime_camera"
      ? (streamRaw as "demo_video" | "realtime_camera")
      : undefined;

  latestTrackingOverlay = {
    tree_id: treeIdOverlay,
    stream_mode,
    demo_iot: readDemoIotFromBody(body),
    telegram_from_overlay: telegramFromCvOverlay,
    median_window_n: Number.isFinite(Number(body.median_window_n)) ? Number(body.median_window_n) : undefined,
    median_window_max: Number.isFinite(Number(body.median_window_max))
      ? Number(body.median_window_max)
      : undefined,
    frame_index: Number(body.frame_index || 0),
    total_frames: Number(body.total_frames || 0),
    video_second: Number(body.video_second ?? body.video_time ?? 0),
    video_time: Number(body.video_time ?? body.video_second ?? 0),
    mapped_timestamp: typeof body.mapped_timestamp === "string" ? body.mapped_timestamp : undefined,
    frame_width: Number(body.frame_width || 0),
    frame_height: Number(body.frame_height || 0),
    polygons: Array.isArray(body.polygons) ? body.polygons : [],
    axes: Array.isArray(body.axes) ? body.axes : [],
    image_base64: typeof body.image_base64 === "string" ? body.image_base64 : undefined,
    health_status: String(body.health_status || "NO_DATA"),
    health_percent: Number(body.health_percent || 0),
    leaf_area_pixels: Number.isFinite(Number(body.leaf_area_pixels))
      ? Number(body.leaf_area_pixels)
      : undefined,
    health_percent_instant: Number.isFinite(Number(body.health_percent_instant))
      ? Number(body.health_percent_instant)
      : undefined,
    health_status_instant:
      typeof body.health_status_instant === "string" ? body.health_status_instant : undefined,
    calibration_complete: body.calibration_complete === true,
    health_ready_for_stable: body.health_ready_for_stable === true,
    updated_at: new Date().toISOString(),
  };
  trackingOverlayBuffer.push(latestTrackingOverlay);
  if (trackingOverlayBuffer.length > OVERLAY_BUFFER_MAX) {
    trackingOverlayBuffer = trackingOverlayBuffer.slice(trackingOverlayBuffer.length - OVERLAY_BUFFER_MAX);
  }

  if (telegramFromCvOverlay && treeIdOverlay) {
    const hp = Number(body.health_percent ?? 0);
    const hs = String(body.health_status || "NO_DATA");
    const mn = Number(body.median_window_n);
    const mm = Number(body.median_window_max);
    const medianSamples = Number.isFinite(mn) && mn >= 0 ? Math.round(mn) : 0;
    const medianWindowMax = Number.isFinite(mm) && mm > 0 ? Math.round(mm) : 60;
    const pumpLabel = pendingIot
      ? `ESP32 pump=${pendingIot.pumpStatus} soil=${pendingIot.soilMoisture}%`
      : "ESP32 (chưa có telemetry RAM)";
    void sendAlert
      .notifyAfterRealtimeTrackingOverlay({
        state: getRealtimeTrackingTelegramState(treeIdOverlay),
        treeId: treeIdOverlay,
        healthPercent: hp,
        healthStatus: hs,
        medianSamples,
        medianWindowMax,
        pumpLabel,
      })
      .catch((e) => console.error("[telegram] realtime overlay:", e));
  }

  res.status(201).json({ success: true });
};

const getRealtimeTrackingOverlay = async (req: Request, res: Response): Promise<void> => {
  const afterFrameRaw = Number(req.query.afterFrame);
  const afterFrame = Number.isFinite(afterFrameRaw) ? Math.max(0, Math.round(afterFrameRaw)) : null;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(300, Math.max(1, Math.round(limitRaw))) : 120;
  let rows = trackingOverlayBuffer;
  if (afterFrame !== null) {
    rows = rows.filter((item) => item.frame_index > afterFrame);
  }
  const sliced = rows.slice(-limit);

  res.status(200).json({
    success: true,
    running: Boolean(activeRealtimeJob),
    latestFrame: latestTrackingOverlay?.frame_index ?? null,
    data: sliced,
  });
};

// =============================================================================
// Spawn Python — paths (không phụ thuộc process.cwd()) + handler
// =============================================================================
const webRootDir = path.resolve(__dirname, "..");
const repoRootDir = path.resolve(__dirname, "..", "..");

const parseBodyHour = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const h = Math.round(n);
  if (h < 0 || h > 23) return fallback;
  return h;
};

const startRealtimeVideoStream = async (req: Request, res: Response): Promise<void> => {
  stopPythonStreamJob();

  const mode = req.body?.mode === "live" ? "realtime" : "demo";
  activePythonStreamMode = mode === "realtime" ? "realtime" : "demo";
  if (mode === "demo") {
    demoTelegramStateByTreeId.clear();
  }
  if (mode === "realtime") {
    realtimeTrackingTelegramByTreeId.clear();
  }
  const cameraUrl =
    typeof req.body?.cameraUrl === "string" && req.body.cameraUrl.trim()
      ? req.body.cameraUrl.trim()
      : "http://192.168.1.3:4747/video";
  const treeId = typeof req.body?.treeId === "string" && req.body.treeId.trim() ? req.body.treeId.trim() : "TREE_001";
  const sendEveryFramesRaw = Number(req.body?.sendEveryFrames);
  const sendEveryFrames = Number.isFinite(sendEveryFramesRaw) && sendEveryFramesRaw > 0 ? Math.round(sendEveryFramesRaw) : 5;
  const startHour = parseBodyHour(req.body?.startHour, 23);
  const endHour = parseBodyHour(req.body?.endHour, 11);
  const pythonScript = path.resolve(repoRootDir, "cv.engine", "video_tracking_stream.py");
  const demoVideoPath = path.resolve(webRootDir, "public", "videos", "final(1).mp4");
  const videoPath = mode === "realtime" ? cameraUrl : demoVideoPath;
  const modelPath = path.resolve(repoRootDir, "models", "best.pt");
  const venvPython = path.resolve(repoRootDir, "cv.engine", "Scripts", "python.exe");
  const pythonCmd = process.env.PYTHON_CMD || (fs.existsSync(venvPython) ? venvPython : "py");
  const demoDataUrl = `${req.protocol}://${req.get("host")}/home/api/demo`;
  const realtimeVisionUrl = `${req.protocol}://${req.get("host")}/home/api/realtime`;
  const trackingApiUrl = `${req.protocol}://${req.get("host")}/home/api/stream/overlay`;

  const child = spawn(
    pythonCmd,
    [
      pythonScript,
      "--video",
      videoPath,
      "--mode",
      mode,
      "--model",
      modelPath,
      "--demo-ingest-url",
      demoDataUrl,
      "--realtime-vision-url",
      realtimeVisionUrl,
      "--camera-url",
      cameraUrl,
      "--tracking-api-url",
      trackingApiUrl,
      "--tree-id",
      treeId,
      "--send-every-frames",
      String(sendEveryFrames),
      "--start-hour",
      String(startHour),
      "--end-hour",
      String(endHour),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  activeRealtimeJob = child;
  child.stdout.on("data", (chunk: Buffer) => {
    console.log(`[video-stream] ${chunk.toString().trim()}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    console.error(`[video-stream-error] ${chunk.toString().trim()}`);
  });
  child.on("close", () => {
    activeRealtimeJob = null;
    activePythonStreamMode = null;
  });
  child.on("error", () => {
    activeRealtimeJob = null;
    activePythonStreamMode = null;
  });

  res.status(201).json({
    success: true,
    message: "Started realtime video analysis stream.",
    mode,
    source: videoPath,
    sendEveryFrames,
    startHour,
    endHour,
    voice_pump_override: voicePumpOverride,
  });
};

/** Dừng process Python — không đụng override giọng nói / logic bơm theo đất. */
const stopRealtimeVideoStream = async (_req: Request, res: Response): Promise<void> => {
  stopPythonStreamJob();
  res.status(200).json({
    success: true,
    message: "Đã dừng luồng AI.",
    ai_running: false,
    voice_pump_override: voicePumpOverride,
  });
};

/** Ghi đè bơm theo giọng nói (ESP32 nhận lệnh ở POST /api/sensors tiếp theo). */
const applyVoicePumpCommand = (cmd: PumpStatus): void => {
  voicePumpOverride = cmd;
  const now = Date.now();
  if (pendingIot) {
    pendingIot = { ...pendingIot, pumpStatus: cmd, updatedAt: now };
  } else {
    pendingIot = {
      soilMoisture: 50,
      temperature: 28,
      pumpStatus: cmd,
      updatedAt: now,
    };
  }
};

/** Điều khiển bơm qua giọng nói (wit.ai) — ghi đè hoàn toàn logic đất cho đến khi bấm Tự động. */
const postIotPumpCommand = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseVoicePumpPostBody(req.body);
  if (parsed.ok === false) {
    res.status(parsed.status).json(parsed.payload);
    return;
  }
  const { command: cmd } = parsed.data;
  applyVoicePumpCommand(cmd);
  res.status(200).json({
    success: true,
    pump_command: cmd,
    pump_reason: VOICE_PUMP_REASON,
    voice_pump_override: voicePumpOverride,
    message: cmd === "ON" ? "Giọng nói: bật bơm (ESP32)." : "Giọng nói: tắt bơm (ESP32).",
  });
};

/** Trả bơm về logic đất + AI (xóa override giọng nói). */
const clearIotPumpOverride = async (_req: Request, res: Response): Promise<void> => {
  voicePumpOverride = null;
  let pumpAfterAuto: PumpCommandResult = { cmd: "OFF", reason: "no_iot" };
  if (pendingIot) {
    pumpAfterAuto = decidePumpCommand(pendingIot.soilMoisture);
    pendingIot = { ...pendingIot, pumpStatus: pumpAfterAuto.cmd, updatedAt: Date.now() };
  }
  res.status(200).json({
    success: true,
    message: "Bơm trở lại chế độ tự động (đất + AI).",
    voice_pump_override: null,
    pump_command: pumpAfterAuto.cmd,
    pump_reason: pumpAfterAuto.reason,
  });
};

/** Web Speech → text → Wit.ai (hoặc parser local) → bơm / đọc cảm biến. */
const postVoiceCommand = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseVoiceCommandPostBody(req.body);
  if (parsed.ok === false) {
    res.status(parsed.status).json(parsed.payload);
    return;
  }
  const { message } = parsed.data;
  const action = await resolveVoiceAction(message);

  if (action.type === "pump") {
    applyVoicePumpCommand(action.command);
    res.status(200).json({
      success: true,
      reply: action.reply,
      transcript: message,
      pump_command: action.command,
      pump_reason: VOICE_PUMP_REASON,
      voice_pump_override: voicePumpOverride,
      wit_configured: isWitConfigured(),
    });
    return;
  }

  if (action.type === "pump_auto") {
    voicePumpOverride = null;
    let pumpAfterAuto: PumpCommandResult = { cmd: "OFF", reason: "no_iot" };
    if (pendingIot) {
      pumpAfterAuto = decidePumpCommand(pendingIot.soilMoisture);
      pendingIot = { ...pendingIot, pumpStatus: pumpAfterAuto.cmd, updatedAt: Date.now() };
    }
    res.status(200).json({
      success: true,
      reply: action.reply,
      transcript: message,
      pump_command: pumpAfterAuto.cmd,
      pump_reason: pumpAfterAuto.reason,
      voice_pump_override: null,
      wit_configured: isWitConfigured(),
    });
    return;
  }

  if (action.type === "reply") {
    res.status(200).json({
      success: true,
      reply: replyFromVoiceAction(action, pendingIot),
      transcript: message,
      pump_command: pendingIot?.pumpStatus ?? null,
      wit_configured: isWitConfigured(),
    });
    return;
  }

  res.status(200).json({
    success: false,
    error: action.reply,
    transcript: message,
    wit_configured: isWitConfigured(),
  });
};

// =============================================================================
// AI snapshot + bơm (ESP32 / GET sensors) — types / hằng + helpers
// =============================================================================
type AiSnapshotSource = "overlay" | "db" | "fallback" | "realtime_pending";

const PUMP_AI_TRIGGER_PERCENT = 80;

// Lấy snapshot AI gần nhất từ overlay hoặc DB dể hiển thị lên màn hình hiển thị
const getLatestAiSnapshot = async (opts?: { useTrackingOverlay?: boolean }): Promise<{
  status: HealthStatus;
  healthPercent: number;
  source: AiSnapshotSource;
}> => {
  const useOverlay = opts?.useTrackingOverlay !== false;

  if (useOverlay && latestTrackingOverlay) {
    const overlayStatus = String(latestTrackingOverlay.health_status || "Healthy");
    const status: HealthStatus = HEALTH_STATUSES.includes(overlayStatus as HealthStatus)
      ? (overlayStatus as HealthStatus)
      : "Healthy";
    return {
      status,
      healthPercent: Number(latestTrackingOverlay.health_percent || 100),
      source: "overlay",
    };
  }

  if (pendingAi) {
    const st = pendingAi.status;
    const status: HealthStatus = HEALTH_STATUSES.includes(st) ? st : "Healthy";
    return {
      status,
      healthPercent: pendingAi.healthPct,
      source: "realtime_pending",
    };
  }

  const recent = await homeService.getRecentTreeSnapshots(1);
  const row0 = recent[0];
  if (row0?.ai_vision_data) {
    return {
      status: row0.ai_vision_data.health_status,
      healthPercent: Number((row0.ai_vision_data.confidence_score || 0) * 100),
      source: "db",
    };
  }
  return { status: "Healthy", healthPercent: 100, source: "fallback" };
};

// =============================================================================
// HTTP handlers (thứ tự gần với home.routes.ts)
// =============================================================================
const getHome = async (req: Request, res: Response): Promise<void> => {
  const rows = await homeService.getRecentTreeSnapshots(200);
  const chartLabels = rows.map((item) => new Date(item.timestamp).toLocaleTimeString("vi-VN"));
  const chartArea = rows.map((item) => (item.iot_data ? item.iot_data.soil_moisture : null));
  const chartHealth = rows.map((item) => item.ai_vision_data?.confidence_score ?? null);
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const lastSensorTimestampIso = lastRow ? new Date(lastRow.createdAt).toISOString() : null;
  const lastSoilMoisture =
    lastRow?.iot_data != null && Number.isFinite(Number(lastRow.iot_data.soil_moisture))
      ? Number(lastRow.iot_data.soil_moisture)
      : null;

  res.render("pages/home/index", {
    pageTitle: "Trang chủ",
    chartLabels: JSON.stringify(chartLabels),
    chartArea: JSON.stringify(chartArea),
    chartHealth: JSON.stringify(chartHealth),
    lastSoilMoisture,
    latestStatus: lastRow?.ai_vision_data?.health_status ?? "NO_DATA",
    lastSensorTimestampIso,
    videoUrl: "/videos/final(1).mp4",
    streamRunning: Boolean(activeRealtimeJob),
  });
};

const postDemoData = async (req: Request, res: Response): Promise<void> => {
  const parsed = parsePostDemoBody(req.body);
  if (parsed.ok === false) {
    res.status(parsed.status).json(parsed.payload);
    return;
  }
  const { treeId, timestamp, iotForSave, aiVision, action_taken } = parsed.data;
  const aiHealthPctFromPayload = Number(aiVision.confidence_score) * 100;
  const demoPump: "ON" | "OFF" = aiVision.health_status !== "Healthy" ? "ON" : "OFF";
  const iotForDemo = { ...iotForSave, pump_status: demoPump };

  const saved = await homeService.saveDemoVideoTreeSnapshot({
    tree_id: treeId,
    timestamp,
    iot_data: iotForDemo,
    ai_vision_data: {
      health_status: aiVision.health_status,
      confidence_score: aiVision.confidence_score,
      camera_image_url: aiVision.camera_image_url,
    },
    action_taken,
  });

  scheduleDemoIngestTelegram({
    treeId,
    healthPercent: aiHealthPctFromPayload,
    healthStatus: aiVision.health_status,
    pumpStatus: iotForDemo.pump_status,
    soilMoisture: iotForDemo.soil_moisture,
  });

  res.status(201).json({
    success: true,
    message: "Demo video payload saved.",
    pump_command: iotForDemo.pump_status,
    health_status: aiVision.health_status,
    health_percent: Number(aiHealthPctFromPayload.toFixed(1)),
    server_time: new Date().toISOString(),
    data: saved,
  });
};

const postRealtime = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseRealtimeAiPostBody(req.body);
  if (parsed.ok === false) {
    res.status(parsed.status).json(parsed.payload);
    return;
  }
  const { treeId, timestamp, aiVision, action_taken } = parsed.data;
  const aiStatusTyped = aiVision.health_status;
  const aiHealthPctFromPayload = Number(aiVision.confidence_score) * 100;

  pendingAi = {
    status: aiStatusTyped,
    healthPct: aiHealthPctFromPayload,
    cameraImageUrl: aiVision.camera_image_url,
    updatedAt: Date.now(),
  };

  const wilted = aiStatusTyped !== "Healthy";
  const now = Date.now();
  const periodicDue = lastRealtimeVisionDbAt === 0 || now - lastRealtimeVisionDbAt >= REALTIME_VISION_DB_INTERVAL_MS;
  const shouldPersist = wilted || periodicDue;

  let persisted = false;
  if (shouldPersist) {
    await saveLiveTreeSnapshot({
      treeId,
      timestamp,
      aiVision: {
        health_status: aiStatusTyped,
        confidence_score: aiVision.confidence_score,
        camera_image_url: aiVision.camera_image_url,
      },
      actionTaken: action_taken,
      ramIot: pendingIot,
    });
    lastRealtimeVisionDbAt = now;
    lastConsolidatedSaveAt = now;
    persisted = true;
  }

  const responsePump: "ON" | "OFF" = pendingIot ? pendingIot.pumpStatus : "OFF";

  res.status(persisted ? 201 : 202).json({
    success: true,
    message: persisted
      ? wilted
        ? "Realtime vision persisted (plant not Healthy)."
        : "Realtime vision persisted (periodic window)."
      : "Realtime vision cached in RAM only (Healthy; next save on wilt or periodic).",
    pump_command: responsePump,
    pump_source: pendingIot ? "iot_ram_mirror" : "default_off_no_iot",
    pump_controlled_by: "esp32_post_sensors_only",
    health_status: aiStatusTyped,
    health_percent: Number(aiHealthPctFromPayload.toFixed(1)),
    ai_advisory_only: true,
    db_write: persisted ? "saved" : "skipped",
    db_interval_minutes: REALTIME_VISION_DB_INTERVAL_MS / (60 * 1000),
    server_time: new Date().toISOString(),
  });
};

const getSensorData = async (req: Request, res: Response): Promise<void> => {
  const after = typeof req.query.after === "string" ? req.query.after : undefined;
  const rows = await homeService.getTreeSnapshotsAfter(after, 200);
  const ai = await getLatestAiSnapshot();

  let latestPumpCommand: "ON" | "OFF" = "OFF";
  let latestSoilMoisture: number | null = null;
  let latestTemperature: number | null = null;
  let latestPh: number | null = null;
  let pumpSource:
    | "ram"
    | "page_db"
    | "db_wide"
    | "default_off"
    | "demo_overlay"
    | "voice_override" = "default_off";

  if (pendingIot) {
    latestPumpCommand = pendingIot.pumpStatus;
    latestSoilMoisture = pendingIot.soilMoisture;
    latestTemperature = pendingIot.temperature;
    latestPh = pendingIot.ph ?? null;
    pumpSource = "ram";
  } else {
    const latestIotRow = [...rows].reverse().find((r) => Boolean(r.iot_data));
    const sourceRow = latestIotRow ?? (await homeService.getLatestTreeSnapshotWithIot());
    if (sourceRow?.iot_data) {
      latestPumpCommand = sourceRow.iot_data.pump_status;
      latestSoilMoisture = sourceRow.iot_data.soil_moisture;
      latestTemperature = sourceRow.iot_data.temperature;
      latestPh = sourceRow.iot_data.ph ?? null;
      pumpSource = latestIotRow ? "page_db" : "db_wide";
    }
  }

  const pumpAfterDemo = pumpCommandForEsp32WithDemoPolicy(
    { cmd: latestPumpCommand, reason: pumpSource },
    ai,
    {
      activePythonStreamMode,
      overlayStreamMode: latestTrackingOverlay?.stream_mode,
    }
  );
  latestPumpCommand = pumpAfterDemo.cmd;
  if (pumpSource === "default_off" && pumpAfterDemo.cmd === "ON") {
    pumpSource = "demo_overlay";
  }
  const finalPump = applyVoiceOverrideIfAny({ cmd: latestPumpCommand, reason: pumpSource });
  latestPumpCommand = finalPump.cmd;
  if (voicePumpOverride !== null) pumpSource = "voice_override";

  res.status(200).json({
    success: true,
    running: Boolean(activeRealtimeJob),
    voice_pump_override: voicePumpOverride,
    latestTimestamp: rows.length ? rows[rows.length - 1].createdAt : after || null,
    latestPumpCommand,
    pumpSource,
    latestHealthStatus: ai.status,
    latestHealthPercent: Number(ai.healthPercent.toFixed(1)),
    latestAiSource: ai.source,
    latestSoilMoisture,
    latestTemperature,
    latestPh,
    threshold_min_moisture: ESP32_DRY_THRESHOLD_PERCENT,
    ai_alert_threshold: PUMP_AI_TRIGGER_PERCENT,
    ai_advisory_only: true,
    server_time: new Date().toISOString(),
    data: rows,
  });
};

const consolidateAndSaveIfDue = async (treeId: string): Promise<boolean> => {
  const now = Date.now();
  if (now - lastConsolidatedSaveAt < LIVE_DB_INTERVAL_MS) return false;
  if (!pendingAi && !pendingIot) return false;

  const aiVision = pendingAi ?? {
    status: "Healthy" as HealthStatus,
    healthPct: 100,
    cameraImageUrl: "consolidated://no-ai-yet",
    updatedAt: now,
  };
  const aiPart = `AI(${aiVision.status} ${aiVision.healthPct.toFixed(1)}%${pendingAi ? "" : ", fallback"})`;
  const iotPart = pendingIot
    ? `IoT(pump=${pendingIot.pumpStatus} soil=${pendingIot.soilMoisture}%)`
    : "IoT(missing)";

  await saveLiveTreeSnapshot({
    treeId,
    timestamp: new Date(),
    aiVision: {
      health_status: aiVision.status,
      confidence_score: Math.max(0, Math.min(1, aiVision.healthPct / 100)),
      camera_image_url: aiVision.cameraImageUrl,
    },
    actionTaken: `Consolidated live (mỗi ${LIVE_DB_INTERVAL_MINUTES}m): ${aiPart} + ${iotPart}`,
    ramIot: pendingIot,
  });
  lastConsolidatedSaveAt = now;
  return true;
};

const postSensorData = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseEsp32SensorsPostBody(req.body);
  if (parsed.ok === false) {
    res.status(parsed.status).json(parsed.payload);
    return;
  }
  const { treeId, soilMoisture, temperature, ph } = parsed.data;

  const soilPump = decidePumpCommand(soilMoisture);
  const aiForPump = await getLatestAiSnapshot({ useTrackingOverlay: activePythonStreamMode === "demo" });
  const pump = applyVoiceOverrideIfAny(
    pumpCommandForEsp32WithDemoPolicy(
      soilPump,
      { status: aiForPump.status, source: aiForPump.source },
      {
        activePythonStreamMode,
        overlayStreamMode: latestTrackingOverlay?.stream_mode,
      }
    )
  );
  const ai = await getLatestAiSnapshot({ useTrackingOverlay: activePythonStreamMode !== "realtime" });

  pendingIot = {
    soilMoisture,
    temperature,
    ph,
    pumpStatus: pump.cmd,
    updatedAt: Date.now(),
  };
  const persisted = await consolidateAndSaveIfDue(treeId);

  res.status(persisted ? 201 : 202).json({
    success: true,
    message: persisted
      ? "ESP32 telemetry received & consolidated record saved."
      : "ESP32 telemetry received; pump command served from RAM (DB save throttled).",
    pump_command: pump.cmd,
    pump_reason: pump.reason,
    health_status: ai.status,
    health_percent: Number(ai.healthPercent.toFixed(1)),
    ai_source: ai.source,
    ai_advisory_only: true,
    threshold_min_moisture: ESP32_DRY_THRESHOLD_PERCENT,
    ai_alert_threshold: PUMP_AI_TRIGGER_PERCENT,
    db_write: persisted ? "saved" : "throttled",
    db_interval_minutes: LIVE_DB_INTERVAL_MINUTES,
    next_db_write_iso: new Date(lastConsolidatedSaveAt + LIVE_DB_INTERVAL_MS).toISOString(),
    server_time: new Date().toISOString(),
  });
};

export default {
  getHome,
  postDemoData,
  postRealtime,
  getSensorData,
  postSensorData,
  startRealtimeVideoStream,
  stopRealtimeVideoStream,
  postIotPumpCommand,
  clearIotPumpOverride,
  postVoiceCommand,
  postRealtimeTrackingOverlay,
  getRealtimeTrackingOverlay,
};
