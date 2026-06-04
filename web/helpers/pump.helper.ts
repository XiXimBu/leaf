import type { HealthStatus } from "../models/sensor.model";
import { clampSoilMoisturePercent } from "../validations/home.validate";

export type PumpCommandResult = { cmd: "ON" | "OFF"; reason: string };
export type VoicePumpOverride = "ON" | "OFF" | null;

/** Bật bơm khi đất khô hơn ngưỡng này. */
export const ESP32_DRY_THRESHOLD_PERCENT = 25;
/** Tắt bơm (khi đang chạy) khi đất đạt ngưỡng này — hysteresis 25% → 60%. */
export const ESP32_WET_THRESHOLD_PERCENT = 60;
export const DEFAULT_PUMP_ADMIN_KEY = "vision-admin";
export const VOICE_PUMP_REASON = "manual_voice";
export const ADMIN_PUMP_REASON = "manual_admin";

/**
 * Bơm tự động theo độ ẩm đất (hysteresis):
 * - Đang TẮT: bật khi đất < 25%
 * - Đang BẬT: chỉ tắt khi đất ≥ 60% (giữa 25–60% vẫn bơm)
 * - Đang TẮT + đất 25–60%: không bật (vùng đủ ẩm tương đối)
 */
export function decidePumpCommand(
  soilMoisture: number,
  currentPumpStatus: "ON" | "OFF" = "OFF",
  dryThresholdPercent: number = ESP32_DRY_THRESHOLD_PERCENT,
  wetThresholdPercent: number = ESP32_WET_THRESHOLD_PERCENT
): PumpCommandResult {
  const soil = clampSoilMoisturePercent(soilMoisture);
  if (!Number.isFinite(soil)) {
    return { cmd: "OFF", reason: "no_soil_data" };
  }

  if (currentPumpStatus === "ON") {
    if (soil >= wetThresholdPercent) {
      return { cmd: "OFF", reason: `soil_wet>=${wetThresholdPercent}%` };
    }
    return { cmd: "ON", reason: `pumping_${dryThresholdPercent}_${wetThresholdPercent}%` };
  }

  if (soil < dryThresholdPercent) {
    return { cmd: "ON", reason: `soil_dry<${dryThresholdPercent}%` };
  }
  if (soil < wetThresholdPercent) {
    return { cmd: "OFF", reason: `soil_mid_${dryThresholdPercent}_${wetThresholdPercent}%_idle` };
  }
  return { cmd: "OFF", reason: `soil_wet>=${wetThresholdPercent}%` };
}

/** Nhãn tiếng Việt cho UI / log (từ pump_reason). */
export function pumpReasonLabel(reason: string): string {
  if (reason === "no_soil_data") return "Không có dữ liệu đất";
  if (reason === VOICE_PUMP_REASON) return "Ghi đè giọng nói";
  if (reason === ADMIN_PUMP_REASON) return "Ghi đè admin";
  if (reason.startsWith("soil_dry<")) return `Đất khô — bật bơm (${reason.replace("soil_dry<", "<")})`;
  if (reason.startsWith("pumping_")) {
    return `Đang tưới — tắt khi đạt ≥${ESP32_WET_THRESHOLD_PERCENT}%`;
  }
  if (reason.includes("_idle")) {
    return `Vùng ${ESP32_DRY_THRESHOLD_PERCENT}–${ESP32_WET_THRESHOLD_PERCENT}% — chưa cần bơm`;
  }
  if (reason.startsWith("soil_wet>=")) {
    return `Đất đủ ẩm — tắt bơm (${reason.replace("soil_wet>=", "≥")})`;
  }
  return reason;
}

export type PumpDemoOverlayContext = {
  activePythonStreamMode: "demo" | "realtime" | null;
  overlayStreamMode?: "demo_video" | "realtime_camera";
};

export function pumpCommandForEsp32WithDemoPolicy(
  soilPump: PumpCommandResult,
  ai: { status: HealthStatus; source: string },
  ctx: PumpDemoOverlayContext
): PumpCommandResult {
  const demoOverlayWantsPump =
    ctx.activePythonStreamMode === "demo" &&
    ctx.overlayStreamMode === "demo_video" &&
    ai.source === "overlay" &&
    ai.status !== "Healthy";

  if (demoOverlayWantsPump) {
    return {
      cmd: "ON",
      reason: "demo_video: lá héo (Python overlay) — bật bơm; đất chỉ mang tính tham khảo",
    };
  }
  return soilPump;
}

/** Chỉ giọng nói (wit.ai) ghi đè — realtime vẫn bơm theo độ ẩm đất khi override = null. */
export function applyVoicePumpOverride(
  pump: PumpCommandResult,
  voiceOverride: VoicePumpOverride
): PumpCommandResult {
  if (voiceOverride === null) return pump;
  return { cmd: voiceOverride, reason: VOICE_PUMP_REASON };
}

/** Admin UI (khóa server) thắng giọng nói và logic đất. */
export function applyManualPumpOverrides(
  pump: PumpCommandResult,
  adminOverride: VoicePumpOverride,
  voiceOverride: VoicePumpOverride
): PumpCommandResult {
  if (adminOverride !== null) {
    return { cmd: adminOverride, reason: ADMIN_PUMP_REASON };
  }
  return applyVoicePumpOverride(pump, voiceOverride);
}
