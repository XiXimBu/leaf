/**
 * Telegram thông báo — dùng chung cho ingest demo và (sau này) realtime.
 */

const telegramEnvTrim = (v: string | undefined): string =>
  typeof v !== "string" ? "" : v.trim().replace(/^["']+|["']+$/g, "");

let cachedToken = "";
let cachedChatId = "";

const readTelegramCredentials = (): { token: string; chatId: string } => {
  if (!cachedToken) {
    cachedToken = telegramEnvTrim(process.env.TELEGRAM_BOT_TOKEN);
    cachedChatId = telegramEnvTrim(process.env.TELEGRAM_CHAT_ID);
  }
  return { token: cachedToken, chatId: cachedChatId };
};

export const isTelegramConfigured = (): boolean => {
  const { token, chatId } = readTelegramCredentials();
  return Boolean(token && chatId);
};

/** Ngưỡng cảnh báo khớp `video_tracking_stream.py` — dưới mức này coi là nhắc bơm (80%). */
export const TELEGRAM_PUMP_ALERT_THRESHOLD_PERCENT = 80;

/** Báo định kỳ khi ingest demo (~15 giây). */
export const TELEGRAM_STATUS_INTERVAL_MS = 15_000;

export type DemoTelegramTreeState = {
  lastPumpForEdge: "ON" | "OFF" | undefined;
  lastPeriodicSentAtMs: number | null;
  latchedPumpAlertBelowThreshold: boolean;
};

export const createDemoTelegramTreeState = (): DemoTelegramTreeState => ({
  lastPumpForEdge: undefined,
  lastPeriodicSentAtMs: null,
  latchedPumpAlertBelowThreshold: false,
});

/** Raw send — tái dùng cho realtime sau này. */
export async function sendTelegramPlainText(text: string): Promise<boolean> {
  const { token, chatId } = readTelegramCredentials();
  if (!token || !chatId) {
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const data = (await response.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      console.warn(`[telegram] sendMessage refused: ${data.description ?? JSON.stringify(data)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[telegram] sendMessage error:", err);
    return false;
  }
}

const healthAlertSnapshotText = (opts: {
  treeId: string;
  healthVal: number;
  statusVi: string;
  pumpThreshold: number;
}): string =>
  [
    "🚨 CẢNH BÁO TỪ HỆ THỐNG AI (demo ingest)",
    `🌱 tree_id: ${opts.treeId}`,
    `🌿 Sức khỏe (confidence→% hiện tại): ${opts.healthVal.toFixed(1)}% — dưới ngưỡng kích hoạt bơm (${opts.pumpThreshold.toFixed(
      0
    )}%)`,
    `📌 Trạng thái: ${opts.statusVi}`,
  ].join("\n");

const periodicReportText = (opts: {
  treeId: string;
  healthVal: number;
  statusVi: string;
  pumpLabel: string;
  intervalSeconds: number;
}): string =>
  [
    `📊 [demo] Báo định kỳ (~${opts.intervalSeconds.toFixed(0)}s)`,
    `🌱 tree_id: ${opts.treeId}`,
    `🌿 Sức khỏe: ${opts.healthVal.toFixed(1)}%`,
    `📌 Trạng thái: ${opts.statusVi}`,
    `🚿 Máy bơm (demo): ${opts.pumpLabel}`,
  ].join("\n");

export const telegramDemoPumpOnText = (
  treeId: string,
  healthVal: number,
  statusVi: string,
  soilPct: number
): string =>
  [
    "🚿 MÁY BƠM ĐÃ BẬT (demo )",
    `🌱 tree_id: ${treeId}`,
    `🌿 Sức khỏe: ${healthVal.toFixed(1)}%`,
    `📌 Trạng thái: ${statusVi}`,
    `💧 Độ ẩm đất: ${soilPct.toFixed(0)}%.`,
  ].join("\n");

export const telegramDemoPumpOffText = (
  treeId: string,
  healthVal: number,
  statusVi: string,
  soilPct: number,
  reason: string
): string =>
  [
    "💧 MÁY BƠM ĐÃ TẮT (demo)",
    `🌱 tree_id: ${treeId}`,
    `🌿 Sức khỏe: ${healthVal.toFixed(1)}%`,
    `📌 Trạng thái: ${statusVi}`,
    `💧 Độ ẩm đất: ${soilPct.toFixed(0)}%`,
    `📝 Lý do: ${reason}`,
  ].join("\n");

/** Trạng thái báo realtime theo luồng tracking (khớp FPS ~ Python cũ). */
export type RealtimeTrackingTelegramState = {
  lastPeriodicSentAtMs: number | null;
  latchedPumpAlertBelowThreshold: boolean;
};

export const createRealtimeTrackingTelegramState = (): RealtimeTrackingTelegramState => ({
  lastPeriodicSentAtMs: null,
  latchedPumpAlertBelowThreshold: false,
});

const realtimeMedianAlertText = (opts: {
  treeId: string;
  healthVal: number;
  statusVi: string;
  nSamples: number;
  nMax: number;
  pumpThreshold: number;
}): string =>
  [
    "🚨 CẢNH BÁO TỪ HỆ THỐNG AI (realtime / camera)",
    `🌱 tree_id: ${opts.treeId}`,
    `🌿 Trung vị (median) sức khỏe: ${opts.healthVal.toFixed(1)}% — dưới ngưỡng kích hoạt bơm (${opts.pumpThreshold.toFixed(
      0
    )}%)`,
    `📌 Trạng thái: ${opts.statusVi}`,
    `📐 Độ ổn định: trung vị trên ${opts.nSamples}/${opts.nMax}.`,
    `⚙️ Vùng 80–85% (Héo nhẹ do gió) chỉ là phân loại; cảnh báo khi dưới ${opts.pumpThreshold.toFixed(0)}% .`,
  ].join("\n");

const realtimePeriodicReportText = (opts: {
  treeId: string;
  healthVal: number;
  statusVi: string;
  nSamples: number;
  nMax: number;
  pumpLabel: string;
  intervalSeconds: number;
}): string =>
  [
    `📊 [AI realtime] Báo định kỳ (~${opts.intervalSeconds.toFixed(0)}s)`,
    `🌱 tree_id: ${opts.treeId}`,
    `🌿 Trung vị (median) sức khỏe: ${opts.healthVal.toFixed(1)}% (${opts.nSamples}/${opts.nMax} mẫu)`,
    `📌 Trạng thái: ${opts.statusVi}`,
    `🚿 Máy bơm: ${opts.pumpLabel}`,
    "💡 Theo trung vị: một vài khung lệch gió có thể bị đẩy hai đầu dãy, giữa vẫn phản ánh thực tế.",
  ].join("\n");

/**
 * Gọi sau mỗi POST overlay tracking khi realtime bật (CV gửi `telegram_from_overlay: true`).
 */
export async function notifyAfterRealtimeTrackingOverlay(opts: {
  state: RealtimeTrackingTelegramState;
  treeId: string;
  healthPercent: number;
  healthStatus: string;
  medianSamples: number;
  medianWindowMax: number;
  pumpLabel: string;
}): Promise<void> {
  const { state, treeId } = opts;
  const hp = opts.healthPercent;
  const hs = opts.healthStatus;
  const ns = opts.medianSamples;
  const nmax = opts.medianWindowMax;
  const pumpLabel = opts.pumpLabel;
  const now = Date.now();

  if (!isTelegramConfigured()) {
    return;
  }

  if (
    hp < TELEGRAM_PUMP_ALERT_THRESHOLD_PERCENT &&
    ns > 0 &&
    !state.latchedPumpAlertBelowThreshold
  ) {
    state.latchedPumpAlertBelowThreshold = true;
    await sendTelegramPlainText(
      realtimeMedianAlertText({
        treeId,
        healthVal: hp,
        statusVi: hs,
        nSamples: ns,
        nMax: nmax,
        pumpThreshold: TELEGRAM_PUMP_ALERT_THRESHOLD_PERCENT,
      })
    );
  }
  if (hp >= TELEGRAM_PUMP_ALERT_THRESHOLD_PERCENT) {
    state.latchedPumpAlertBelowThreshold = false;
  }

  if (state.lastPeriodicSentAtMs === null) {
    state.lastPeriodicSentAtMs = now;
    return;
  }
  const elapsed = now - state.lastPeriodicSentAtMs;
  if (elapsed >= TELEGRAM_STATUS_INTERVAL_MS && ns > 0) {
    state.lastPeriodicSentAtMs = now;
    await sendTelegramPlainText(
      realtimePeriodicReportText({
        treeId,
        healthVal: hp,
        statusVi: hs,
        nSamples: ns,
        nMax: nmax,
        pumpLabel,
        intervalSeconds: TELEGRAM_STATUS_INTERVAL_MS / 1000,
      })
    );
  }
}

/**
 * Gọi sau mỗi lần lưu ingest demo hoàn tất — cập nhật state mutable theo tree_id.
 * Chạy không chặn HTTP: `void notifyAfterDemoIngestAlerts(...).catch(...)`.
 */
export async function notifyAfterDemoIngestAlerts(opts: {
  state: DemoTelegramTreeState;
  treeId: string;
  healthPercent: number;
  healthStatus: string;
  pumpStatus: "ON" | "OFF";
  soilMoisture: number;
}): Promise<void> {
  const { state, treeId } = opts;
  const hp = opts.healthPercent;
  const hs = opts.healthStatus;
  const pump = opts.pumpStatus;
  const soil = opts.soilMoisture;
  const now = Date.now();

  if (!isTelegramConfigured()) {
    console.warn("[telegram] bỏ qua demo ingest: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID chưa cấu hình trong web/.env.");
    await Promise.resolve();
    return;
  }

  if (hp < TELEGRAM_PUMP_ALERT_THRESHOLD_PERCENT && !state.latchedPumpAlertBelowThreshold) {
    state.latchedPumpAlertBelowThreshold = true;
    await sendTelegramPlainText(
      healthAlertSnapshotText({
        treeId,
        healthVal: hp,
        statusVi: hs,
        pumpThreshold: TELEGRAM_PUMP_ALERT_THRESHOLD_PERCENT,
      })
    );
  }
  if (hp >= TELEGRAM_PUMP_ALERT_THRESHOLD_PERCENT) {
    state.latchedPumpAlertBelowThreshold = false;
  }

  const prevPump = state.lastPumpForEdge ?? "OFF";
  if (prevPump !== pump) {
    if (pump === "ON") {
      await sendTelegramPlainText(telegramDemoPumpOnText(treeId, hp, hs, soil));
    } else {
      await sendTelegramPlainText(
        telegramDemoPumpOffText(treeId, hp, hs, soil, "Healthy / rule tắt bơm")
      );
    }
  }
  state.lastPumpForEdge = pump;

  if (state.lastPeriodicSentAtMs === null) {
    state.lastPeriodicSentAtMs = now;
  } else {
    const elapsedPeriodic = now - state.lastPeriodicSentAtMs;
    if (elapsedPeriodic >= TELEGRAM_STATUS_INTERVAL_MS) {
      state.lastPeriodicSentAtMs = now;
      await sendTelegramPlainText(
        periodicReportText({
          treeId,
          healthVal: hp,
          statusVi: hs,
          pumpLabel: pump,
          intervalSeconds: TELEGRAM_STATUS_INTERVAL_MS / 1000,
        })
      );
    }
  }
}
