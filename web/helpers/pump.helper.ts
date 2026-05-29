import type { HealthStatus } from "../models/sensor.model";
import { clampSoilMoisturePercent } from "../validations/home.validate";

export type PumpCommandResult = { cmd: "ON" | "OFF"; reason: string };
export type VoicePumpOverride = "ON" | "OFF" | null;

export const ESP32_DRY_THRESHOLD_PERCENT = 25;
export const VOICE_PUMP_REASON = "manual_voice";

/** Bơm theo độ ẩm đất ESP32. Không có số hợp lệ → OFF. */
export function decidePumpCommand(
  soilMoisture: number,
  dryThresholdPercent: number = ESP32_DRY_THRESHOLD_PERCENT
): PumpCommandResult {
  const soil = clampSoilMoisturePercent(soilMoisture);
  if (!Number.isFinite(soil)) {
    return { cmd: "OFF", reason: "no_soil_data" };
  }
  if (soil < dryThresholdPercent) {
    return { cmd: "ON", reason: `soil_dry<${dryThresholdPercent}%` };
  }
  return { cmd: "OFF", reason: `soil_ok=${soil.toFixed(1)}%` };
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
