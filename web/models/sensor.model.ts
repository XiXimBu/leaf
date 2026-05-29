import mongoose from "mongoose";

/** Trạng thái sức khỏe cây từ AI vision */
export type HealthStatus = "Héo" | "Héo nhẹ" | "Healthy";

export interface IotData {
  soil_moisture: number;
  temperature: number;
  ph?: number;
  pump_status: "ON" | "OFF";
}

export interface AiVisionData {
  health_status: HealthStatus;
  confidence_score: number;
  camera_image_url: string;
}

// Đổi tên từ SensorDocument thành TreeSnapshotDocument
export interface TreeSnapshotDocument {
  tree_id: string;
  timestamp: Date;
  
  // Cả AI và IoT đều là Optional để hệ thống không sụp đổ nếu 1 trong 2 thiết bị mất mạng
  iot_data?: IotData;
  ai_vision_data?: AiVisionData;
  
  action_taken: string;
  createdAt: Date;
  updatedAt: Date;
}

const iotDataSchema = new mongoose.Schema<IotData>(
  {
    soil_moisture: { type: Number, required: true },
    temperature: { type: Number, required: true },
    ph: { type: Number, required: false, min: 0, max: 14 },
    pump_status: { type: String, enum: ["ON", "OFF"], required: true },
  },
  { _id: false } // Không tạo ObjectId thừa cho sub-document
);

const aiVisionDataSchema = new mongoose.Schema<AiVisionData>(
  {
    health_status: { type: String, enum: ["Héo", "Héo nhẹ", "Healthy"], required: true },
    confidence_score: { type: Number, required: true, min: 0, max: 1 },
    camera_image_url: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const treeSnapshotSchema = new mongoose.Schema<TreeSnapshotDocument>(
  {
    tree_id: { type: String, required: true, trim: true, index: true },
    timestamp: { type: Date, required: true, index: true },
    
    // IoT và AI giờ đây đều có thể null/undefined khi lỗi mạng
    iot_data: { type: iotDataSchema, required: false, default: undefined },
    ai_vision_data: { type: aiVisionDataSchema, required: false, default: undefined },
    
    action_taken: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

// Đổi tên Model và Collection thành 'TreeSnapshot' và 'tree_snapshots'
const TreeSnapshot = mongoose.model<TreeSnapshotDocument>("TreeSnapshot", treeSnapshotSchema, "tree_snapshots");

export default TreeSnapshot;