const API = "";

function $(id) { return document.getElementById(id); }

function showResult(el, type, text) {
  el.className = "result " + type;
  el.textContent = text;
}

function parseJson(text) {
  try { return [JSON.parse(text), null]; }
  catch (e) { return [null, "JSON không hợp lệ: " + e.message]; }
}

// Field metadata cần gỡ trước khi so sánh — không phải dữ liệu nghiệp vụ.
//   _id, _rev, ~version   → CouchDB / Fabric state DB tự thêm
//   __v, createdAt, updatedAt → Mongoose tự thêm
//   docType, id           → các bản chaincode cũ tự thêm (đã bỏ ở version mới)
const STRIP_FIELDS = new Set([
  "_id", "_rev", "~version",
  "__v", "createdAt", "updatedAt",
  "docType", "id",
]);

// Chuẩn hoá object về schema gốc + sort key → dùng cho diff & deepEqual.
// Tự gỡ wrapper của MongoDB Extended JSON ({$oid}, {$date}, ...) và
// wrapper _all_docs của CouchDB ({key, value:{rev}, doc:{...}}).
function canon(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canon);

  if (v.doc && typeof v.doc === "object" &&
      ("key" in v || "_id" in v.doc || "_rev" in v.doc)) {
    return canon(v.doc);
  }

  const keys = Object.keys(v);
  if (keys.length === 1) {
    if ("$oid" in v) return String(v.$oid);
    if ("$date" in v) {
      const d = v.$date;
      return typeof d === "object" && d && "$numberLong" in d
        ? new Date(Number(d.$numberLong)).toISOString()
        : String(d);
    }
    if ("$numberLong" in v) return Number(v.$numberLong);
    if ("$numberInt" in v) return Number(v.$numberInt);
    if ("$numberDouble" in v) return Number(v.$numberDouble);
    if ("$numberDecimal" in v) return Number(v.$numberDecimal);
  }

  const out = {};
  for (const k of keys.sort()) {
    if (STRIP_FIELDS.has(k)) continue;
    out[k] = canon(v[k]);
  }
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function diffKeys(a, b) {
  const na = canon(a);
  const nb = canon(b);
  const ka = na && typeof na === "object" && !Array.isArray(na) ? Object.keys(na) : [];
  const kb = nb && typeof nb === "object" && !Array.isArray(nb) ? Object.keys(nb) : [];
  const all = new Set([...ka, ...kb]);
  const diffs = [];
  for (const k of all) {
    const va = na ? na[k] : undefined;
    const vb = nb ? nb[k] : undefined;
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      diffs.push({ key: k, db: va, chain: vb });
    }
  }
  return diffs;
}

async function getLatest(id) {
  const res = await fetch(API + "/api/blockchain/history/" + encodeURIComponent(id));
  if (!res.ok) throw new Error("HTTP " + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("Chưa có bản ghi nào trên blockchain cho id này");
  }
  return arr[arr.length - 1];
}

// ===== Audio siren via Web Audio API =====
let audioCtx = null;
let sirenTimer = null;
function startSiren() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    stopSiren();
    const beep = () => {
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sawtooth";
      osc.connect(gain).connect(audioCtx.destination);
      osc.frequency.setValueAtTime(700, t);
      osc.frequency.linearRampToValueAtTime(1300, t + 0.35);
      osc.frequency.linearRampToValueAtTime(700, t + 0.7);
      gain.gain.setValueAtTime(0.0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.05);
      gain.gain.linearRampToValueAtTime(0.0, t + 0.7);
      osc.start(t);
      osc.stop(t + 0.72);
    };
    beep();
    sirenTimer = setInterval(beep, 720);
  } catch (e) {
    console.warn("Không phát được còi:", e);
  }
}
function stopSiren() {
  if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; }
}

function triggerAlarm() {
  $("alarm").classList.add("show");
  startSiren();
  if (navigator.vibrate) navigator.vibrate([400, 120, 400, 120, 400]);
}
function closeAlarm() {
  $("alarm").classList.remove("show");
  stopSiren();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

$("btnCloseAlarm").addEventListener("click", closeAlarm);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAlarm(); });

// ===== Check integrity =====
$("btnCheck").addEventListener("click", async () => {
  const id = $("checkId").value.trim();
  const raw = $("dbData").value.trim();
  const out = $("checkResult");
  if (!id) return showResult(out, "err", "Hãy nhập tree_id");
  if (!raw) return showResult(out, "err", "Hãy dán dữ liệu database");
  const [dbObj, err] = parseJson(raw);
  if (err) return showResult(out, "err", err);

  showResult(out, "warn", "Đang truy vấn blockchain...");
  try {
    const latest = await getLatest(id);
    const chainData = latest.data || {};
    const equal = deepEqual(dbObj, chainData);
    if (equal) {
      showResult(out, "ok",
        "✅ TOÀN VẸN — Dữ liệu database trùng khớp với bản ghi mới nhất trên blockchain.\n" +
        "txid: " + (latest.txid || "-"));
    } else {
      const diffs = diffKeys(dbObj, chainData);
      const lines = diffs.map(d =>
        `• ${d.key}: database=${JSON.stringify(d.db)}  ≠  blockchain=${JSON.stringify(d.chain)}`
      ).join("\n");
      showResult(out, "err",
        "❌ KHÔNG TRÙNG KHỚP\n" +
        "Sai lệch:\n" + lines + "\n\n" +
        "txid blockchain mới nhất: " + (latest.txid || "-"));
      triggerAlarm();
    }
  } catch (e) {
    showResult(out, "err", "Lỗi: " + e.message);
  }
});

$("btnLoadLatest").addEventListener("click", async () => {
  const id = $("checkId").value.trim();
  const out = $("checkResult");
  if (!id) return showResult(out, "err", "Hãy nhập tree_id");
  try {
    showResult(out, "warn", "Đang tải...");
    const latest = await getLatest(id);
    $("dbData").value = JSON.stringify(latest.data, null, 2);
    showResult(out, "ok", "Đã điền dữ liệu mới nhất từ blockchain. Bấm 'Kiểm tra ngay' để xác nhận.");
  } catch (e) {
    showResult(out, "err", "Lỗi: " + e.message);
  }
});

// ===== History =====
$("btnHistory").addEventListener("click", async () => {
  const id = $("histId").value.trim();
  const box = $("historyBox");
  const out = $("histResult");
  box.classList.remove("show");
  box.innerHTML = "";
  if (!id) return showResult(out, "err", "Hãy nhập tree_id");
  showResult(out, "warn", "Đang tải lịch sử...");
  try {
    const res = await fetch(API + "/api/blockchain/history/" + encodeURIComponent(id));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) {
      return showResult(out, "warn", "Không có bản ghi nào cho id này.");
    }
    box.innerHTML = arr.map((item, i) => {
      const ts = item.block_timestamp
        ? `${item.block_timestamp.seconds || ""}.${(item.block_timestamp.nanos || 0)}`
        : "-";
      return `
        <div class="hist-item">
          <div class="meta">#${i + 1} · txid: ${item.txid || "-"} · block_ts: ${ts}</div>
          <pre>${escapeHtml(JSON.stringify(item.data, null, 2))}</pre>
        </div>`;
    }).join("");
    box.classList.add("show");
    showResult(out, "ok", `Đã tải ${arr.length} bản ghi.`);
  } catch (e) {
    showResult(out, "err", "Lỗi: " + e.message);
  }
});

// ===== Record =====
$("btnRecord").addEventListener("click", async () => {
  const raw = $("recPayload").value.trim();
  const out = $("recResult");
  if (!raw) return showResult(out, "err", "Hãy nhập payload");
  const [obj, err] = parseJson(raw);
  if (err) return showResult(out, "err", err);
  if (!obj.tree_id) return showResult(out, "err", "Payload thiếu trường tree_id");
  showResult(out, "warn", "Đang gửi lên blockchain...");
  try {
    const res = await fetch(API + "/api/blockchain/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    showResult(out, "ok", "✅ Đã ghi: " + (body.message || "OK"));
  } catch (e) {
    showResult(out, "err", "Lỗi: " + e.message);
  }
});
