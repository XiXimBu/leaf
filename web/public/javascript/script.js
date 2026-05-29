(() => {
  const chartPayload = window.__PLANT_CHART_DATA__ || {};
  const importConfig = window.__VIDEO_IMPORT_CONFIG__ || {};
  const labels = Array.isArray(chartPayload.labels) ? [...chartPayload.labels] : [];
  /** DB/SSR có thể lưu confidence 0–1; biểu đồ sức khỏe là % 0–100 (khớp ngưỡng Healthy ≥85, Python HEALTHY_PERCENT_MIN). */
  const toHealthPercentSeries = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return [...arr];
    const nums = arr.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (!nums.length) return [...arr];
    const mx = Math.max(...nums.map((n) => Math.abs(n)));
    if (mx > 1.5) return arr.map((v) => (Number.isFinite(Number(v)) ? Number(v) : v));
    return arr.map((v) => (Number.isFinite(Number(v)) ? Number(v) * 100 : v));
  };
  let healthData = toHealthPercentSeries(chartPayload.healthData || []);
  /** Khớp SSR: có thể dùng cùng dãy %. Khi có tracking — đường median tách riêng. */
  let medianHealthData = Array.isArray(chartPayload.medianHealthData)
    ? toHealthPercentSeries(chartPayload.medianHealthData)
    : [...healthData];
  /** Stress lá 0–100 = 100 − % lá (khung tức thời / live); 3 chữ số để gần 100 vẫn nhấp nhô theo instant, không dính một đường phẳng. */
  const stressFromHealthPct = (hp) => {
    const x = Number(hp);
    if (!Number.isFinite(x)) return null;
    const raw = 100 - x;
    return Number(Math.max(0, Math.min(100, raw)).toFixed(3));
  };
  let leafStressData = labels.map((_, i) =>
    stressFromHealthPct(medianHealthData[i] ?? healthData[i])
  );
  const btnDemo = document.getElementById("btnDemoMode");
  const btnLive = document.getElementById("btnLiveMode");
  const btnStopAll = document.getElementById("btnStopAll");
  const btnPumpAuto = document.getElementById("btnPumpAuto");
  const btnVoiceMic = document.getElementById("btnVoiceMic");
  const voiceTextInput = document.getElementById("voiceTextInput");
  const voiceStatus = document.getElementById("voiceStatus");
  const voiceLastCommand = document.getElementById("voiceLastCommand");
  const liveBadge = document.getElementById("liveBadge");
  const livePulseDot = document.getElementById("livePulseDot");
  const importStatus = document.getElementById("importStatus");
  const videoOverlay = document.getElementById("videoOverlay");
  const overlayCtx = videoOverlay ? videoOverlay.getContext("2d") : null;
  const ipCameraUrl = importConfig.ipCameraUrl || "http://192.168.1.3:4747/video";
  const latestStatusLine = document.getElementById("latestStatusLine");
  const heroAiStatus = document.getElementById("heroAiStatus");
  const streamStatusLabel = document.getElementById("streamStatusLabel");

  const setHeroAiStatus = (status) => {
    if (!heroAiStatus || typeof status !== "string" || !status.length) return;
    heroAiStatus.textContent = status;
    heroAiStatus.classList.remove("text-secondary", "text-error", "text-amber-300", "text-on-surface");
    if (status === "Healthy") heroAiStatus.classList.add("text-secondary");
    else if (status === "Héo") heroAiStatus.classList.add("text-error");
    else if (status === "Héo nhẹ") heroAiStatus.classList.add("text-amber-300");
    else heroAiStatus.classList.add("text-on-surface");
  };

  let currentMode = "demo";
  let latestTimestamp = importConfig.lastSensorTimestampIso || null;
  let latestFrame = 0;
  let lastChartFrameFromTracking = -1;
  let lastRenderedFrame = -1;
  let drawToken = 0;
  let livePollTimer = null;
  let trackingPollTimer = null;
  let streamActive = false;

  const setStreamUiActive = (on) => {
    streamActive = Boolean(on);
    if (liveBadge) {
      liveBadge.classList.toggle("hidden", !on);
      liveBadge.classList.toggle("flex", on);
    }
    if (livePulseDot) {
      livePulseDot.className = on
        ? "w-2 h-2 rounded-full bg-secondary animate-pulse shadow-[0_0_8px_rgba(61,214,140,0.55)]"
        : "w-2 h-2 rounded-full bg-on-surface-variant";
    }
    if (streamStatusLabel) {
      streamStatusLabel.textContent = on
        ? "Live feed đang chạy"
        : "VisionComputer — đã dừng";
    }
  };

  const stopRealtimePolling = () => {
    if (livePollTimer !== null) {
      window.clearInterval(livePollTimer);
      livePollTimer = null;
    }
    if (trackingPollTimer !== null) {
      window.clearInterval(trackingPollTimer);
      trackingPollTimer = null;
    }
  };
  let lastSoilSensorsFetchMs = 0;
  const reusableImg = new Image();
  let lastCanvasW = 0;
  let lastCanvasH = 0;
  let lastFrameW = 0;
  let lastFrameH = 0;

  const movingAverage = (data, windowSize = 3) =>
    data.map((_, i) => {
      const start = Math.max(0, i - windowSize + 1);
      const slice = data.slice(start, i + 1).filter((v) => Number.isFinite(v));
      if (!slice.length) return 0;
      return Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2));
    });


  /** Vùng tô dưới đường sức khỏe chính — gradient theo vùng vẽ chart. */
  const healthAreaFill = (context) => {
    const chart = context.chart;
    const { ctx, chartArea } = chart;
    if (!chartArea) return "rgba(34, 197, 94, 0.08)";
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, "rgba(34, 197, 94, 0.2)");
    g.addColorStop(0.45, "rgba(34, 197, 94, 0.07)");
    g.addColorStop(1, "rgba(34, 197, 94, 0)");
    return g;
  };

  const chartMutedGrid = "rgba(100, 116, 139, 0.14)";
  const chartTickColor = "#64748b";
  const chartFont = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  const rawLastSoil = chartPayload.lastSoilMoisture;
  const initialBarSoil =
    rawLastSoil !== undefined && rawLastSoil !== null && Number.isFinite(Number(rawLastSoil))
      ? Number(rawLastSoil)
      : null;
  let iotSnapshot = {
    soil: initialBarSoil,
    temp: null,
    ph: null,
    pump: null,
  };

  const iotEls = {
    soil: document.getElementById("iotSoilValue"),
    temp: document.getElementById("iotTempValue"),
    ph: document.getElementById("iotPhValue"),
    pump: document.getElementById("iotPumpValue"),
    pumpHint: document.getElementById("iotPumpHint"),
    caption: document.getElementById("iotMetricsCaption"),
    grid: document.getElementById("iotMetricsGrid"),
  };
  const hasIotPanel = Boolean(iotEls.grid || iotEls.temp || iotEls.pump);

  const pumpValueClass = (state) => {
    const base = "text-3xl font-semibold block leading-none ";
    if (state === "ON") return `${base}text-emerald-300`;
    if (state === "OFF") return `${base}text-on-primary-container/70`;
    return `${base}text-on-primary-container`;
  };

  const sensorsApiUrl = () => importConfig.liveEndpoint || "/home/api/sensors";

  const refreshIotMetricsPanel = () => {
    if (!hasIotPanel) return;
    const s = iotSnapshot.soil;
    const t = iotSnapshot.temp;
    const p = iotSnapshot.ph;
    const pump = iotSnapshot.pump;

    if (iotEls.soil) {
      iotEls.soil.textContent = Number.isFinite(s) ? `${Math.round(s)}` : "--";
    }
    const heroSoil = document.getElementById("heroSoilMoisture");
    if (heroSoil) {
      heroSoil.textContent = Number.isFinite(s) ? `${Math.round(s)}%` : "--%";
    }
    const heroSoilBar = document.getElementById("heroSoilBarFill");
    if (heroSoilBar) {
      heroSoilBar.style.width = Number.isFinite(s)
        ? `${Math.min(100, Math.max(0, s))}%`
        : "0%";
    }
    if (iotEls.temp) {
      iotEls.temp.textContent = Number.isFinite(t) ? t.toFixed(1) : "--";
    }
    if (iotEls.ph) {
      iotEls.ph.textContent = Number.isFinite(p) ? p.toFixed(2) : "--";
    }
    if (iotEls.pump) {
      if (pump === "ON") {
        iotEls.pump.textContent = "BẬT";
        iotEls.pump.className = pumpValueClass("ON");
      } else if (pump === "OFF") {
        iotEls.pump.textContent = "TẮT";
        iotEls.pump.className = pumpValueClass("OFF");
      } else {
        iotEls.pump.textContent = "--";
        iotEls.pump.className = pumpValueClass("");
      }
    }
    if (iotEls.pumpHint) {
      if (pump === "ON") iotEls.pumpHint.textContent = "Đang tưới (rơ-le ON)";
      else if (pump === "OFF") iotEls.pumpHint.textContent = "Đang nghỉ (rơ-le OFF)";
      else iotEls.pumpHint.textContent = "Chờ lệnh từ server / ESP32";
    }
    if (iotEls.caption) {
      const bits = [];
      if (Number.isFinite(s)) bits.push(`Đất: ${s.toFixed(0)}%`);
      if (Number.isFinite(t)) bits.push(`${t.toFixed(1)}°C`);
      if (Number.isFinite(p)) bits.push(`pH ${p.toFixed(2)}`);
      if (pump) bits.push(`Bơm ${pump}`);
      iotEls.caption.textContent =
        bits.length > 0
          ? `Cập nhật: ${bits.join(" · ")}`
          : "Chưa có dữ liệu — bấm Start Demo hoặc Start Live, hoặc chờ ESP32.";
    }
  };

  /** GET /home/api/sensors — đồng bộ ô IoT (live / ESP32). */
  const applySensorsPayloadToIot = (data) => {
    if (!data || data.success !== true) return;
    if (Number.isFinite(Number(data.latestSoilMoisture))) {
      iotSnapshot.soil = Number(data.latestSoilMoisture);
    }
    if (Number.isFinite(Number(data.latestTemperature))) {
      iotSnapshot.temp = Number(data.latestTemperature);
    }
    if (Number.isFinite(Number(data.latestPh))) {
      iotSnapshot.ph = Number(data.latestPh);
    }
    if (data.latestPumpCommand) iotSnapshot.pump = String(data.latestPumpCommand);
    refreshIotMetricsPanel();
  };

  const fetchIotFromSensors = async () => {
    try {
      const response = await fetch(sensorsApiUrl());
      const data = await response.json();
      applySensorsPayloadToIot(data);
    } catch (_e) {}
  };

  const updateIotFromTrackingLatest = (latest) => {
    if (!latest || !hasIotPanel) return;
    if (latest.stream_mode === "demo_video" && latest.demo_iot) {
      const sm = Number(latest.demo_iot.soil_moisture);
      const tp = Number(latest.demo_iot.temperature);
      const ph = Number(latest.demo_iot.ph);
      const pu = latest.demo_iot.pump_status;
      if (Number.isFinite(sm)) iotSnapshot.soil = sm;
      if (Number.isFinite(tp)) iotSnapshot.temp = tp;
      if (Number.isFinite(ph)) iotSnapshot.ph = ph;
      if (typeof pu === "string" && pu.length) iotSnapshot.pump = pu;
      refreshIotMetricsPanel();
    }
  };

  const chartElement = document.getElementById("plantAreaChart");
  let chartInstance = null;
  if (chartElement && typeof Chart !== "undefined") {
    chartInstance = new Chart(chartElement, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Stress lá (100 − % khung tức thời)",
            data: leafStressData,
            borderColor: "rgba(6, 182, 212, 0.55)",
            borderWidth: 2,
            tension: 0.22,
            yAxisID: "y1",
            pointRadius: 0,
            pointHoverRadius: 4,
            pointStyle: "line",
          },
          {
            label: "Stress lá MA(3)",
            data: movingAverage(leafStressData, 3),
            borderColor: "#0891b2",
            borderWidth: 2.25,
            tension: 0.28,
            yAxisID: "y1",
            pointRadius: 0,
            pointHoverRadius: 4,
            pointStyle: "line",
          },
          {
            // Đường chính (đậm) — stable health (median CV demo / median live) — KHỚP với ESP32 và blockchain.
            label: "Sức khỏe ổn định (median %)",
            data: healthData,
            borderColor: "rgb(22, 163, 74)",
            backgroundColor: healthAreaFill,
            borderWidth: 3,
            tension: 0.22,
            yAxisID: "y",
            pointRadius: 0,
            pointHoverRadius: 5,
            fill: true,
            pointStyle: "line",
          },
          {
            // MA của stable để mượt hơn nữa khi biểu diễn timelapse.
            label: "Sức khỏe MA(3)",
            data: movingAverage(healthData, 3),
            borderColor: "rgba(21, 128, 61, 0.92)",
            borderWidth: 2,
            tension: 0.3,
            yAxisID: "y",
            pointRadius: 0,
            pointHoverRadius: 4,
            pointStyle: "line",
          },
          {
            // Ngưỡng kích hoạt bơm (khớp PUMP_TRIGGER_PERCENT trong Python và PUMP_AI_TRIGGER_PERCENT ở backend).
            label: "Ngưỡng bơm 80%",
            data: labels.map(() => 80),
            borderColor: "rgba(234, 88, 12, 0.9)",
            borderWidth: 2,
            borderDash: [12, 8],
            tension: 0,
            yAxisID: "y",
            pointRadius: 0,
            fill: false,
            pointStyle: "line",
          },
          {
            // Đường phụ (mảnh, đứt nét) — instant từng frame (cây đổ / lá rung).
            label: "Khung hiện (instant)",
            data: medianHealthData,
            borderColor: "rgba(71, 85, 105, 0.55)",
            borderDash: [5, 4],
            borderWidth: 1.25,
            tension: 0.22,
            yAxisID: "y",
            pointRadius: 0,
            pointHoverRadius: 3,
            pointStyle: "line",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 520, easing: "easeOutQuart" },
        interaction: { mode: "index", intersect: false, axis: "x" },
        layout: { padding: { top: 10, right: 14, bottom: 6, left: 6 } },
        /** Chart.js v4: không nối đường qua null / khoảng trống (áp dụng mọi dataset type line). */
        datasets: {
          line: {
            spanGaps: false,
          },
        },
        elements: {
          line: {
            borderJoinStyle: "round",
            borderCapStyle: "round",
          },
          point: {
            hoverBorderWidth: 2,
          },
        },
        plugins: {
          legend: {
            position: "bottom",
            align: "start",
            labels: {
              boxWidth: 28,
              boxHeight: 3,
              padding: 12,
              usePointStyle: true,
              pointStyle: "line",
              font: { family: chartFont, size: 11 },
              color: "#334155",
            },
          },
          tooltip: {
            backgroundColor: "rgba(15, 23, 42, 0.94)",
            titleColor: "#f1f5f9",
            bodyColor: "#e2e8f0",
            borderColor: "rgba(148, 163, 184, 0.35)",
            borderWidth: 1,
            padding: 12,
            cornerRadius: 10,
            titleFont: { family: chartFont, size: 12, weight: "600" },
            bodyFont: { family: chartFont, size: 12 },
            displayColors: true,
            boxPadding: 6,
            callbacks: {
              label(ctx) {
                const i = ctx.dataIndex;
                const name = ctx.dataset.label ? `${ctx.dataset.label}: ` : "";
                const f = (n, d) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
                if (ctx.datasetIndex === 0) return ` ${name}${f(leafStressData[i], 3)}% (giá trị gốc)`;
                if (ctx.datasetIndex === 1)
                  return ` ${name}${f(movingAverage(leafStressData, 3)[i], 2)}% (giá trị gốc)`;
                if (ctx.datasetIndex === 2) return ` ${name}${f(healthData[i], 2)}% (giá trị gốc)`;
                if (ctx.datasetIndex === 3)
                  return ` ${name}${f(movingAverage(healthData, 3)[i], 2)}% (giá trị gốc)`;
                const y = ctx.parsed?.y;
                return ` ${name}${Number.isFinite(y) ? f(y, 2) : "—"}`;
              },
            },
          },
        },
        scales: {
          x: {
            offset: true,
            grid: {
              color: chartMutedGrid,
              drawTicks: false,
            },
            border: { display: false },
            ticks: {
              color: chartTickColor,
              font: { family: chartFont, size: 11 },
              maxRotation: 0,
              minRotation: 0,
              autoSkip: true,
              autoSkipPadding: 20,
              maxTicksLimit: 10,
            },
          },
          y: {
            type: "linear",
            position: "left",
            // Không khóa 0–100: trục tự zoom theo cực đại/cực tiểu dữ liệu (vd. chỉ dao động 80–95 vẫn “phồng” rõ đường).
            suggestedMin: 0,
            grace: "10%",
            grid: {
              color: chartMutedGrid,
              drawTicks: false,
            },
            border: { display: false },
            ticks: {
              maxTicksLimit: 10,
              color: chartTickColor,
              font: { family: chartFont, size: 11 },
              padding: 8,
            },
            title: {
              display: true,
              text: "Sức khỏe lá (%)",
              color: "#475569",
              font: { family: chartFont, size: 12, weight: "600" },
              padding: { bottom: 6 },
            },
          },
          y1: {
            type: "linear",
            position: "right",
            reverse: true, // Stress tăng → đường đi xuống, cùng chiều cảm giác với đường sức khỏe
            grace: "10%",
            grid: { drawOnChartArea: false },
            border: { display: false },
            ticks: {
              maxTicksLimit: 10,
              color: "#0f766e",
              font: { family: chartFont, size: 11 },
              padding: 8,
            },
            title: {
              display: true,
              text: "Stress lá (Càng thấp càng stress)",
              color: "#0f766e",
              font: { family: chartFont, size: 12, weight: "600" },
              padding: { bottom: 6 },
            },
          },
        },
      },
    });
  }

  if (hasIotPanel) refreshIotMetricsPanel();

  const resizeOverlay = (frameWidth = 0, frameHeight = 0, force = false) => {
    if (!videoOverlay) return;
    const parentWidth = Math.max(1, Math.round(videoOverlay.clientWidth || 760));
    const ratio = frameWidth > 0 && frameHeight > 0 ? frameHeight / frameWidth : 9 / 16;
    const targetHeight = Math.max(1, Math.round(parentWidth * ratio));
    if (!force && parentWidth === lastCanvasW && targetHeight === lastCanvasH && frameWidth === lastFrameW && frameHeight === lastFrameH) {
      return;
    }
    videoOverlay.width = parentWidth;
    videoOverlay.height = targetHeight;
    lastCanvasW = parentWidth;
    lastCanvasH = targetHeight;
    lastFrameW = frameWidth;
    lastFrameH = frameHeight;
  };

  const drawOverlay = (overlayData) => {
    if (!overlayCtx || !videoOverlay || !overlayData || !overlayData.image_base64) return;
    const frameIndex = Number(overlayData.frame_index || 0);
    if (frameIndex < lastRenderedFrame) return;
    const token = ++drawToken;
    const frameW = Math.max(overlayData.frame_width || 0, 1);
    const frameH = Math.max(overlayData.frame_height || 0, 1);
    resizeOverlay(frameW, frameH);
    reusableImg.onload = () => {
      if (token !== drawToken) return;
      requestAnimationFrame(() => {
        if (token !== drawToken) return;
        overlayCtx.drawImage(reusableImg, 0, 0, videoOverlay.width, videoOverlay.height);
        const sx = videoOverlay.width / frameW;
        const sy = videoOverlay.height / frameH;
        overlayCtx.lineWidth = 2;
        overlayCtx.strokeStyle = "rgba(255,255,0,0.95)";
        (overlayData.polygons || []).forEach((polygon) => {
          if (!Array.isArray(polygon) || polygon.length < 2) return;
          overlayCtx.beginPath();
          polygon.forEach((p, idx) =>
            idx === 0
              ? overlayCtx.moveTo((p[0] || 0) * sx, (p[1] || 0) * sy)
              : overlayCtx.lineTo((p[0] || 0) * sx, (p[1] || 0) * sy)
          );
          overlayCtx.closePath();
          overlayCtx.stroke();
        });
        overlayCtx.strokeStyle = "rgba(0,255,255,0.95)";
        overlayCtx.fillStyle = "rgba(0,255,255,0.95)";
        overlayCtx.font = "14px sans-serif";
        (overlayData.axes || []).forEach((axis) => {
          const x1 = (axis.pt1?.[0] || 0) * sx;
          const y1 = (axis.pt1?.[1] || 0) * sy;
          const x2 = (axis.pt2?.[0] || 0) * sx;
          const y2 = (axis.pt2?.[1] || 0) * sy;
          overlayCtx.beginPath();
          overlayCtx.moveTo(x1, y1);
          overlayCtx.lineTo(x2, y2);
          overlayCtx.stroke();
          overlayCtx.fillText(axis.label || "Target Leaf", x1 + 6, y1 - 6);
        });
        lastRenderedFrame = frameIndex;
      });
    };
    reusableImg.src = overlayData.image_base64;
  };

  const updateChartSoilLabels = () => {
    if (!chartInstance) return;
    const demoSoil = currentMode === "demo";
    chartInstance.data.datasets[0].label = demoSoil
      ? "Stress lá (100 − % khung tức thời)"
      : "Stress lá (100 − % AI / khung)";
    chartInstance.data.datasets[1].label = "Stress lá MA(3)";
    chartInstance.options.scales.y1.title.text = "Stress lá (Càng thấp càng stress)";
  };

  const refreshChart = () => {
    if (!chartInstance) return;
    updateChartSoilLabels();
    chartInstance.data.labels = labels;
    // Index khớp datasets ở init: 0=Stress lá, 1=Stress lá MA(3), 2=Sức khỏe ổn định (đậm),
    // 3=Sức khỏe ổn định MA(3), 4=Ngưỡng bơm 80%, 5=% khung tức thời (instant).
    chartInstance.data.datasets[0].data = leafStressData;
    chartInstance.data.datasets[1].data = movingAverage(leafStressData, 3);
    chartInstance.data.datasets[2].data = healthData;
    chartInstance.data.datasets[3].data = movingAverage(healthData, 3);
    chartInstance.data.datasets[4].data = labels.map(() => 80);
    chartInstance.data.datasets[5].data = medianHealthData;
    chartInstance.update("none");
  };

  const pollLive = async () => {
    // Chỉ live camera: bơm đồng bộ DB qua GET /home/api/sensors. Demo dùng pollTracking (Python overlay).
    if (currentMode !== "live") return;
    try {
      const query = latestTimestamp ? `?after=${encodeURIComponent(latestTimestamp)}` : "";
      const response = await fetch(`${sensorsApiUrl()}${query}`);
      const data = await response.json();
      if (!response.ok || !data.success) return;
      applySensorsPayloadToIot(data);
      if (!Array.isArray(data.data)) return;
      data.data.forEach((row) => {
        labels.push(new Date(row.timestamp).toLocaleTimeString("vi-VN"));
        // Record AI-only (Python live, không có iot_data) → push null để chart hiển thị gap, không vỡ.
        const h = Number((row.ai_vision_data?.confidence_score ?? 0) * 100);
        healthData.push(h);
        medianHealthData.push(h);
        leafStressData.push(stressFromHealthPct(h));
        if (labels.length > 220) {
          labels.shift();
          healthData.shift();
          medianHealthData.shift();
          leafStressData.shift();
        }
      });
      latestTimestamp = data.latestTimestamp || latestTimestamp;
      if (data.data.length && latestStatusLine) {
        const last = data.data[data.data.length - 1];
        const st = last?.ai_vision_data?.health_status;
        const pump = data.latestPumpCommand;
        const soil = data.latestSoilMoisture;
        const parts = [];
        if (st) parts.push(`Trạng thái: ${st}`);
        if (pump) parts.push(`Bơm: ${pump}`);
        if (Number.isFinite(Number(soil))) parts.push(`Đất ESP32: ${Number(soil).toFixed(0)}%`);
        const phVal = data.latestPh;
        if (Number.isFinite(Number(phVal))) parts.push(`pH: ${Number(phVal).toFixed(2)}`);
        if (parts.length) latestStatusLine.textContent = parts.join("  ·  ");
        if (st) setHeroAiStatus(st);
      }
      refreshChart();
    } catch (_e) {}
  };

  /** Nhãn trục X: ISO từ Python (timeline timelapse demo / server live), không ép mọi điểm vào “giây máy chủ”. */
  const chartLabelFromTrackingPoint = (pt) => {
    const iso = pt?.mapped_timestamp;
    if (typeof iso === "string" && iso.length > 4) {
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d.toLocaleTimeString("vi-VN");
    }
    return new Date().toLocaleTimeString("vi-VN");
  };

  const pollTracking = async () => {
    try {
      const query = `?afterFrame=${encodeURIComponent(String(latestFrame))}&limit=180`;
      const response = await fetch(
        `${importConfig.trackingEndpoint || "/home/api/stream/overlay"}${query}`
      );
      const data = await response.json();
      if (!response.ok || !data.success || !Array.isArray(data.data)) return;
      if (data.data.length) {
        const sorted = [...data.data].sort((a, b) => Number(a.frame_index || 0) - Number(b.frame_index || 0));
        const latest = sorted[sorted.length - 1];
        const incomingFrame = Number(latest.frame_index || 0);
        latestFrame = Math.max(latestFrame, incomingFrame);
        drawOverlay(latest);
        updateIotFromTrackingLatest(latest);
        // Live camera: overlay không có demo_iot — lấy ẩm đất/nhiệt/bơm từ GET /api/sensors (kể cả khi UI đang Demo nhưng Python là realtime_camera).
        if (latest.stream_mode === "realtime_camera" && currentMode !== "live") {
          const now = Date.now();
          if (now - lastSoilSensorsFetchMs >= 1600) {
            lastSoilSensorsFetchMs = now;
            void fetchIotFromSensors();
          }
        }

        let chartDirty = false;
        for (const pt of sorted) {
          const fi = Number(pt.frame_index || 0);
          if (fi <= lastChartFrameFromTracking) continue;
          const stableRaw = Number(pt.health_percent ?? 0);
          const hasInst = pt.health_percent_instant !== undefined && pt.health_percent_instant !== null;
          const instantRaw = hasInst ? Number(pt.health_percent_instant) : stableRaw;
          const stable = Number.isFinite(stableRaw) ? stableRaw : instantRaw;
          const instant = Number.isFinite(instantRaw) ? instantRaw : stable;
          labels.push(chartLabelFromTrackingPoint(pt));
          leafStressData.push(stressFromHealthPct(instant));
          healthData.push(Number(stable.toFixed(2)));
          medianHealthData.push(Number(instant.toFixed(2)));
          if (labels.length > 220) {
            labels.shift();
            leafStressData.shift();
            healthData.shift();
            medianHealthData.shift();
          }
          chartDirty = true;
          lastChartFrameFromTracking = fi;
        }
        if (chartDirty) {
          refreshChart();
          if (latestStatusLine) {
            // Hiển thị stable (ổn định) — khớp với log ESP32 + Telegram + DB. Instant vẽ riêng trên chart (đường xám).
            const stableStatus = typeof latest.health_status === "string" ? latest.health_status : "";
            const stablePct = Number(latest.health_percent);
            const insStatus = typeof latest.health_status_instant === "string" ? latest.health_status_instant : "";
            const insPct = Number(latest.health_percent_instant);
            const lines = [];
            if (stableStatus && Number.isFinite(stablePct)) {
              lines.push(`${stableStatus} (${stablePct.toFixed(1)}%)`);
            }
            if (insStatus && Number.isFinite(insPct) && Math.abs(insPct - stablePct) > 1) {
              lines.push(`Khung hình hiện: ${insStatus} (${insPct.toFixed(1)}%)`);
            }
            if (latest.stream_mode === "demo_video" && latest.demo_iot) {
              const phStr = Number.isFinite(Number(latest.demo_iot.ph)) ? ` · pH ${Number(latest.demo_iot.ph).toFixed(2)}` : "";
              lines.push(
                `đất ${Number(latest.demo_iot.soil_moisture).toFixed(0)}% · bơm ${latest.demo_iot.pump_status} · ${Number(latest.demo_iot.temperature).toFixed(1)}°C${phStr}`
              );
            } else if (latest.stream_mode === "realtime_camera") {
              lines.push("Live: bơm/đất chỉ theo ESP32 — AI chỉ đánh giá lá trên overlay");
            }
            if (latest.health_ready_for_stable !== true) {
              lines.push("Đường % xanh: khung hình (median sau khi đủ mẫu + hết hiệu chuẩn baseline)");
            }
            if (lines.length) latestStatusLine.textContent = lines.join("  ·  ");
            if (stableStatus) setHeroAiStatus(stableStatus);
          }
        }
        if (importStatus) importStatus.textContent = "Đang phân tích…";
        if (streamStatusLabel) streamStatusLabel.textContent = "Live feed đang chạy";
      }
    } catch (_e) {}
  };

  const startLivePolling = () => {
    if (livePollTimer !== null) return;
    pollLive();
    livePollTimer = window.setInterval(pollLive, 500);
  };

  const startTrackingPolling = () => {
    if (trackingPollTimer !== null) return;
    pollTracking();
    void pollTracking();
    trackingPollTimer = window.setInterval(pollTracking, 120);
  };

  const startRealtimePolling = () => {
    startLivePolling();
    startTrackingPolling();
  };

  const readHourFromInput = (inputId, fallback) => {
    const el = document.getElementById(inputId);
    if (!el || !(el instanceof HTMLInputElement)) return fallback;
    const n = Number(el.value);
    if (!Number.isFinite(n)) return fallback;
    const h = Math.round(n);
    if (h < 0 || h > 23) return fallback;
    return h;
  };

  const postPumpCommand = async (command) => {
    const url = importConfig.pumpCommandEndpoint || "/home/api/iot/pump";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, source: "voice" }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (voiceStatus) voiceStatus.textContent = data.message || "Lệnh bơm thất bại.";
        return false;
      }
      iotSnapshot.pump = command;
      refreshIotMetricsPanel();
      if (voiceLastCommand) {
        voiceLastCommand.textContent = `Đã gửi: ${command === "ON" ? "Bật" : "Tắt"} bơm (ESP32).`;
        voiceLastCommand.classList.remove("hidden");
      }
      if (voiceStatus) voiceStatus.textContent = data.message || "OK";
      void fetchIotFromSensors();
      return true;
    } catch (_e) {
      if (voiceStatus) voiceStatus.textContent = "Không gọi được API bơm.";
      return false;
    }
  };

  const clearPumpOverride = async () => {
    const url = importConfig.pumpAutoEndpoint || "/home/api/iot/pump-override";
    try {
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.pump_command) iotSnapshot.pump = String(data.pump_command);
        refreshIotMetricsPanel();
        if (voiceStatus) {
          voiceStatus.textContent =
            data.message || "Bơm: chế độ tự động (đất + AI).";
        }
        if (voiceLastCommand) {
          voiceLastCommand.textContent = data.pump_command
            ? `Tự động: bơm ${data.pump_command} (${data.pump_reason || "đất"})`
            : "Đã trả bơm về chế độ tự động.";
          voiceLastCommand.classList.remove("hidden");
        }
      }
      void fetchIotFromSensors();
    } catch (_e) {}
  };

  const parseVoicePumpCommand = (text) => {
    const t = String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (!t.trim()) return null;
    const hasPump = t.includes("bom") || t.includes("may bom") || t.includes("bơm");
    if (!hasPump) return null;
    if (t.includes("tat") || t.includes("dung") || t.includes("off")) return "OFF";
    if (t.includes("bat") || t.includes("mo") || t.includes("on")) return "ON";
    return null;
  };

  const sendVoiceMessage = async (text) => {
    const spoken = String(text || "").trim();
    if (!spoken) return false;

    if (voiceTextInput) voiceTextInput.value = spoken;
    if (voiceStatus) {
      voiceStatus.textContent = "⏳ Đang gửi lên server (Wit.ai)…";
      voiceStatus.className = "text-[11px] text-primary mt-1.5";
    }

    const url = importConfig.voiceCommandEndpoint || "/home/api/voice-command";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: spoken }),
      });
      const data = await res.json();

      if (voiceLastCommand) {
        voiceLastCommand.textContent = `Bạn nói: «${spoken}»`;
        voiceLastCommand.classList.remove("hidden");
      }

      if (!res.ok || data.success === false) {
        const err = data.error || data.message || "Lệnh không thực hiện được.";
        if (voiceStatus) {
          voiceStatus.textContent = `❌ ${err}`;
          voiceStatus.className = "text-[11px] text-error mt-1.5";
        }
        return false;
      }

      if (data.pump_command) {
        iotSnapshot.pump = String(data.pump_command);
        refreshIotMetricsPanel();
      }
      if (voiceStatus) {
        voiceStatus.textContent = `✅ ${data.reply || "OK"}`;
        voiceStatus.className = "text-[11px] text-secondary mt-1.5";
      }
      void fetchIotFromSensors();
      return true;
    } catch (_e) {
      const cmd = parseVoicePumpCommand(spoken);
      if (cmd) {
        if (voiceStatus) voiceStatus.textContent = "Mất kết nối server — thử lệnh bơm local…";
        return postPumpCommand(cmd);
      }
      if (voiceStatus) {
        voiceStatus.textContent = "❌ Không gọi được API giọng nói.";
        voiceStatus.className = "text-[11px] text-error mt-1.5";
      }
      return false;
    }
  };

  const runVoiceText = async (text) => {
    await sendVoiceMessage(text);
  };

  const stopAll = async () => {
    stopRealtimePolling();
    setStreamUiActive(false);
    const url = importConfig.stopEndpoint || "/home/api/stream/stop";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (importStatus) {
        importStatus.textContent = data.success ? "Đã dừng AI" : "Dừng AI (lỗi phản hồi)";
      }
    } catch (_e) {
      if (importStatus) importStatus.textContent = "Không gọi được API dừng.";
    }
    drawToken += 1;
    if (overlayCtx && videoOverlay) {
      overlayCtx.clearRect(0, 0, videoOverlay.width, videoOverlay.height);
    }
    void fetchIotFromSensors();
  };

  const startMode = async (mode) => {
    currentMode = mode;
    setStreamUiActive(true);
    startRealtimePolling();
    iotSnapshot = { soil: null, temp: null, ph: null, pump: null };
    refreshIotMetricsPanel();
    updateChartSoilLabels();
    if (mode === "live") {
      void fetchIotFromSensors();
    }
    latestFrame = 0;
    lastChartFrameFromTracking = -1;
    lastRenderedFrame = -1;
    drawToken += 1;
    if (overlayCtx && videoOverlay) {
      overlayCtx.clearRect(0, 0, videoOverlay.width, videoOverlay.height);
    }
    resizeOverlay(0, 0, true);
    if (importStatus) importStatus.textContent = "Đang khởi động AI...";
    try {
      const res = await fetch(importConfig.startEndpoint || "/home/api/stream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          cameraUrl: ipCameraUrl,
          sendEveryFrames: 1,
          startHour: readHourFromInput("cvStartHour", 23),
          endHour: readHourFromInput("cvEndHour", 11),
        }),
      });
      if (!res.ok) setStreamUiActive(false);
    } catch (_e) {
      setStreamUiActive(false);
      if (importStatus) importStatus.textContent = "Không khởi động được AI.";
    }
  };

  if (btnDemo) btnDemo.addEventListener("click", () => startMode("demo"));
  if (btnLive) btnLive.addEventListener("click", () => startMode("live"));
  if (btnStopAll) btnStopAll.addEventListener("click", () => void stopAll());
  if (btnPumpAuto) btnPumpAuto.addEventListener("click", () => void clearPumpOverride());

  document.querySelectorAll(".voice-chip").forEach((el) => {
    el.addEventListener("click", () => {
      const cmd = el.getAttribute("data-voice-cmd") || "";
      if (voiceTextInput) voiceTextInput.value = cmd;
      void runVoiceText(cmd);
    });
  });

  if (voiceTextInput) {
    voiceTextInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void runVoiceText(voiceTextInput.value);
    });
  }

  if (btnVoiceMic) {
    const SpeechRecognitionCtor =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      if (voiceStatus) {
        voiceStatus.textContent =
          "Trình duyệt không hỗ trợ mic — dùng Chrome hoặc nhập lệnh bên dưới.";
      }
      btnVoiceMic.addEventListener("click", () => {
        if (voiceTextInput) voiceTextInput.focus();
      });
    } else {
      const recognition = new SpeechRecognitionCtor();
      recognition.lang = "vi-VN";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      let listening = false;

      recognition.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) void sendVoiceMessage(transcript);
      };

      recognition.onend = () => {
        listening = false;
        btnVoiceMic.classList.remove("ring-2", "ring-primary");
      };

      recognition.onerror = (event) => {
        listening = false;
        btnVoiceMic.classList.remove("ring-2", "ring-primary");
        if (voiceStatus) {
          voiceStatus.textContent = `⚠️ Mic: ${event.error || "lỗi"} — thử lại hoặc gõ lệnh.`;
          voiceStatus.className = "text-[11px] text-error mt-1.5";
        }
      };

      btnVoiceMic.addEventListener("click", () => {
        if (listening) {
          recognition.stop();
          return;
        }
        try {
          recognition.start();
          listening = true;
          btnVoiceMic.classList.add("ring-2", "ring-primary");
          if (voiceStatus) {
            voiceStatus.textContent =
              "🔊 Đang nghe… (vd: bật máy bơm, tắt máy bơm, độ ẩm đất)";
            voiceStatus.className = "text-[11px] text-amber-300 mt-1.5";
          }
        } catch (_e) {
          if (voiceStatus) voiceStatus.textContent = "Không mở được mic — thử lại.";
        }
      });
    }
  }
  window.addEventListener("resize", () => resizeOverlay(lastFrameW, lastFrameH, true));
  resizeOverlay(0, 0, true);

  const wasStreamRunning = importConfig.streamRunning === true || importConfig.streamRunning === "true";
  if (wasStreamRunning) {
    setStreamUiActive(true);
    startRealtimePolling();
    void fetchIotFromSensors();
  }
  if (chartInstance) refreshChart();
})();
 