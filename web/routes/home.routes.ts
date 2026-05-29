import { Router } from "express";
import homeController from "../controllers/home.controller";

const router: Router = Router();

router.get("/", homeController.getHome);
router.post("/api/demo", homeController.postDemoData);
router.post("/api/realtime", homeController.postRealtime); 
router.get("/api/sensors", homeController.getSensorData);
router.post("/api/sensors", homeController.postSensorData);

/** Một cổng spawn Python (mode demo | live) — cùng binary cho cả hai. */
router.post("/api/stream/start", homeController.startRealtimeVideoStream);
router.post("/api/stream/stop", homeController.stopRealtimeVideoStream);
router.post("/api/iot/pump", homeController.postIotPumpCommand);
router.delete("/api/iot/pump-override", homeController.clearIotPumpOverride);
router.post("/api/voice-command", homeController.postVoiceCommand);
/** Overlay JSON từ Python (demo + realtime) — POST nhận frame, GET poll theo afterFrame. */
router.post("/api/stream/overlay", homeController.postRealtimeTrackingOverlay);
router.get("/api/stream/overlay", homeController.getRealtimeTrackingOverlay);

export default router;
