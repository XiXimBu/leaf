import "dotenv/config";
import mongoose from "mongoose";
import Sensor from "./models/sensor.model";

const clearSensorData = async (): Promise<void> => {
  const uri = process.env.MONGOOSE_URL || process.env.MONGO_URI;
  if (!uri) {
    console.error("Missing MongoDB URI. Set MONGOOSE_URL or MONGO_URI in .env");
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    const result = await Sensor.deleteMany({});
    console.log(`Deleted ${result.deletedCount ?? 0} documents from sensors collection.`);
  } catch (error) {
    console.error("Failed to clear sensors collection:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

clearSensorData();
