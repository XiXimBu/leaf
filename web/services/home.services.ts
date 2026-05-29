/**
 * Lưu/đọc `tree_snapshots` (model TreeSnapshot) — map route (prefix /home):
 * - POST /api/demo + parsePostDemoBody → saveDemoVideoTreeSnapshot
 * - POST /api/realtime + parseRealtimeAiPostBody → pendingAi + saveTreeSnapshot (throttle riêng trong controller)
 * - POST /api/sensors + parseEsp32SensorsPostBody → pendingIot + consolidateAndSaveIfDue
 * - GET /api/sensors → getTreeSnapshotsAfter (+ RAM pump trong controller)
 * - POST /api/stream/start → spawn Python; POST|GET /api/stream/overlay → buffer tracking (demo + live)
 */
import TreeSnapshot, { AiVisionData, IotData, TreeSnapshotDocument } from "../models/sensor.model";

export interface TreeSnapshotInput {
  tree_id: string;
  timestamp?: string | Date;
  /** Optional — ESP32 hoặc gộp snapshot; AI-only từ POST /api/realtime không gửi field này. */
  iot_data?: IotData;
  ai_vision_data: AiVisionData;
  action_taken: string;
}

/** Payload chuẩn cho POST /api/demo — video demo bắt buộc có IoT giả lập (không dùng cho realtime/ESP32). */
export type DemoVideoTreeSnapshotInput = Omit<TreeSnapshotInput, "iot_data"> & {
  iot_data: IotData;
};

const buildDoc = (payload: TreeSnapshotInput) => {
  const doc: Record<string, unknown> = {
    tree_id: payload.tree_id,
    timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    ai_vision_data: payload.ai_vision_data,
    action_taken: payload.action_taken,
  };
  // Bỏ hẳn field nếu không có → Mongo lưu không kèm `iot_data` (record AI-only).
  if (payload.iot_data) doc.iot_data = payload.iot_data;
  return doc;
};

const sendToBlockchain = async (doc: Record<string, unknown>) => {
  try {
    const response = await fetch('http://localhost:8080/api/blockchain/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!response.ok) {
      console.error(`[Blockchain] Failed to save record: ${response.statusText}`);
    } else {
      console.log(`[Blockchain] Successfully saved record for tree: ${doc.tree_id}`);
    }
  } catch (error) {
    console.error('[Blockchain] Error communicating with gateway:', error);
  }
};

const saveTreeSnapshot = async (payload: TreeSnapshotInput): Promise<TreeSnapshotDocument> => {
  const doc = buildDoc(payload);
  const created = await TreeSnapshot.create(doc);
  sendToBlockchain(doc).catch(console.error);
  return created.toObject() as TreeSnapshotDocument;
};

/** Lưu 1 bản ghi từ chế độ demo video (Python timelapse): luôn kèm IoT + AI, không qua consolidator. */
const saveDemoVideoTreeSnapshot = async (
  payload: DemoVideoTreeSnapshotInput
): Promise<TreeSnapshotDocument> => {
  const doc = buildDoc(payload);
  const created = await TreeSnapshot.create(doc);
  sendToBlockchain(doc).catch(console.error);
  return created.toObject() as TreeSnapshotDocument;
};

const saveTreeSnapshotsBulk = async (payloads: TreeSnapshotInput[]): Promise<number> => {
  if (!payloads.length) return 0;
  const docs = payloads.map(buildDoc);
  const result = await TreeSnapshot.insertMany(docs, { ordered: false });
  return result.length;
};

const getRecentTreeSnapshots = async (limit = 100): Promise<TreeSnapshotDocument[]> => {
  const rows = await TreeSnapshot.find({})
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean<TreeSnapshotDocument[]>();
  return rows.reverse();
};

const getTreeSnapshotsAfter = async (after?: string, limit = 120):Promise<TreeSnapshotDocument[]> => {
  // Realtime cursor must follow DB insertion order, not AI payload timestamp.
  const query = after ? { createdAt: { $gt: new Date(after) } } : {};
  const rows = await TreeSnapshot.find(query)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean<TreeSnapshotDocument[]>();
  return rows;
};

/** Lấy snapshot mới nhất có `iot_data` (bỏ qua bản ghi AI-only). Dùng cho /sensors live snapshot. */
const getLatestTreeSnapshotWithIot = async (): Promise<TreeSnapshotDocument | null> => {
  const row = await TreeSnapshot.findOne({ iot_data: { $exists: true, $ne: null } })
    .sort({ createdAt: -1 })
    .lean<TreeSnapshotDocument | null>();
  return row;
};

export default {
  saveTreeSnapshot,
  saveDemoVideoTreeSnapshot,
  saveTreeSnapshotsBulk,
  getRecentTreeSnapshots,
  getTreeSnapshotsAfter,
  getLatestTreeSnapshotWithIot,
};
