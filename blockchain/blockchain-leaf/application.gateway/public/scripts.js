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

// Parse JSON rồi chuẩn hoá: unwrap CouchDB {_all_docs}, Mongo Extended JSON, gỡ metadata.
function parsePayload(text) {
  const [raw, err] = parseJson(text);
  if (err) return [null, err];
  const payload = canon(raw);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [null, "Payload phải là object JSON (hoặc bọc trong doc của CouchDB)"];
  }
  return [payload, null];
}

function resolveTreeId(payload, fallback) {
  const id = payload.tree_id || payload.key || fallback || "";
  return String(id).trim();
}

// Field metadata cần gỡ trước khi so sánh — không phải dữ liệu nghiệp vụ.
//   _id, _rev, ~version   → CouchDB / Fabric state DB tự thêm
//   __v, createdAt, updatedAt → Mongoose tự thêm
//   docType, id           → các bản chaincode cũ tự thêm (đã bỏ ở version mới)
const STRIP_FIELDS = new Set([
  "_id", "_rev", "~version",
  "__v", "createdAt", "updatedAt",
  "docType", "id",
  "payload_hash",
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

async function fetchHistory(id) {
  const res = await fetch(API + "/api/blockchain/history/" + encodeURIComponent(id));
  if (!res.ok) throw new Error("HTTP " + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("Chưa có bản ghi nào trên blockchain cho id này");
  }
  return arr;
}

async function getLatest(id) {
  const arr = await fetchHistory(id);
  return arr[arr.length - 1];
}

function normalizedPayload(obj) {
  return canon(obj);
}

function canonicalJson(obj) {
  return JSON.stringify(normalizedPayload(obj));
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPayload(obj) {
  return sha256Hex(canonicalJson(obj));
}

function formatRecordTime(data) {
  const t = data && data.timestamp;
  if (!t) return "-";
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && "$date" in t) return String(t.$date);
  return String(t);
}

function formatBlockTs(bt) {
  if (!bt || typeof bt !== "object") return "-";
  let s = bt.seconds;
  if (s && typeof s === "object" && "low" in s) {
    s = Number(s.high || 0) * 4294967296 + (Number(s.low) >>> 0);
  } else if (typeof s === "string") {
    s = Number(s);
  }
  const ms = (Number(s) || 0) * 1000 + Math.floor(Number(bt.nanos || 0) / 1e6);
  if (!ms) return "-";
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
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
  const raw = $("dbData").value.trim();
  const out = $("checkResult");
  if (!raw) return showResult(out, "err", "Hãy dán dữ liệu database");
  const [dbObj, err] = parsePayload(raw);
  if (err) return showResult(out, "err", err);
  const id = resolveTreeId(dbObj, $("checkId").value.trim());
  if (!id) return showResult(out, "err", "Hãy nhập tree_id hoặc dán JSON có tree_id (trong doc CouchDB cũng được)");

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

// ===== SHA-256 + record + history verify =====
$("btnComputeHash").addEventListener("click", async () => {
  const raw = $("recPayload").value.trim();
  const out = $("recResult");
  if (!raw) return showResult(out, "err", "Hãy nhập payload");
  const [obj, err] = parsePayload(raw);
  if (err) return showResult(out, "err", err);
  try {
    const norm = normalizedPayload(obj);
    const canonStr = JSON.stringify(norm);
    const hash = await sha256Hex(canonStr);
    $("recHash").value = hash;
    showResult(out, "ok", "SHA-256:\n" + hash + "\n\nJSON:\n" + canonStr);
  } catch (e) {
    showResult(out, "err", "Lỗi tính hash: " + e.message);
  }
});

$("btnRecord").addEventListener("click", async () => {
  const raw = $("recPayload").value.trim();
  const out = $("recResult");
  if (!raw) return showResult(out, "err", "Hãy nhập payload");
  const [obj, err] = parsePayload(raw);
  if (err) return showResult(out, "err", err);
  const treeId = resolveTreeId(obj);
  if (!treeId) return showResult(out, "err", "Không tìm thấy tree_id (có thể nằm trong doc CouchDB — dán nguyên JSON _all_docs)");
  showResult(out, "warn", "Đang tính hash và gửi lên blockchain...");
  try {
    const norm = normalizedPayload(obj);
    const canonStr = JSON.stringify(norm);
    const hash = await sha256Hex(canonStr);
    $("recHash").value = hash;
    const toWrite = { ...norm, tree_id: treeId, payload_hash: hash };
    const res = await fetch(API + "/api/blockchain/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toWrite)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    showResult(out, "ok",
      "✅ Đã ghi lên blockchain.\n" +
      "payload_hash: " + hash + "\n" +
      (body.message || ""));
  } catch (e) {
    showResult(out, "err", "Lỗi: " + e.message);
  }
});

$("btnVerifyHash").addEventListener("click", async () => {
  const raw = $("recPayload").value.trim();
  const out = $("recResult");
  const box = $("hashHistoryBox");
  box.classList.remove("show");
  box.innerHTML = "";

  if (!raw) return showResult(out, "err", "Hãy nhập payload JSON");
  const [obj, err] = parsePayload(raw);
  if (err) return showResult(out, "err", err);
  const treeId = resolveTreeId(obj);
  if (!treeId) return showResult(out, "err", "Không tìm thấy tree_id (dán nguyên JSON CouchDB { key, doc } cũng được)");

  showResult(out, "warn", "Đang tải lịch sử và đối chiếu hash...");
  try {
    const normInput = normalizedPayload(obj);
    const canonInputStr = JSON.stringify(normInput);
    const userHash = await sha256Hex(canonInputStr);
    $("recHash").value = userHash;

    const history = await fetchHistory(treeId);
    const rows = [];
    const matchIndexes = [];

    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      const data = item.data || {};
      const normChain = normalizedPayload(data);
      const canonChainStr = JSON.stringify(normChain);
      const computed = await sha256Hex(canonChainStr);
      const stored = (data.payload_hash || "").toLowerCase();
      const matchUser = computed === userHash;
      if (matchUser) matchIndexes.push(i);

      rows.push({
        index: i + 1,
        recordTime: formatRecordTime(data),
        blockTime: formatBlockTs(item.block_timestamp),
        txid: item.txid || "-",
        computed,
        canonStr: canonChainStr,
        stored,
        matchUser,
        isLatest: i === history.length - 1,
      });
    }

    const latestIdx = history.length - 1;

    box.innerHTML = rows.map(r => {
      const flags = [];
      if (r.isLatest) flags.push("MỚI NHẤT");
      if (r.matchUser) flags.push("KHỚP");
      const badge = flags.length ? " · " + flags.join(" · ") : "";
      const storedLine = r.stored
        ? `<div class="meta">hash trên chain (payload_hash): <code class="hash-full">${escapeHtml(r.stored)}</code></div>`
        : "";
      const canonBlock = r.matchUser
        ? `<pre class="canon-pre">${escapeHtml(r.canonStr)}</pre>`
        : "";
      return `
        <div class="hist-item ${r.matchUser ? "hash-match" : ""}">
          <div class="meta">#${r.index}${badge} · record: ${escapeHtml(r.recordTime)} · block: ${escapeHtml(r.blockTime)}</div>
          <div class="meta">txid: ${escapeHtml(r.txid)}</div>
          <code class="hash-full">${escapeHtml(r.computed)}</code>
          ${storedLine}
          ${canonBlock}
        </div>`;
    }).join("");
    box.classList.add("show");

    let msg = "Hash:\n" + userHash + "\n\n";
    msg += "JSON:\n" + canonInputStr + "\n\n";
    if (matchIndexes.length === 0) {
      msg += "❌ KHÔNG khớp bất kỳ bản ghi nào trên blockchain.\n";
      msg += "→ Dữ liệu có thể đã bị sửa ngoài chain (Mongo/CouchDB) hoặc chưa từng được ghi.";
      showResult(out, "err", msg);
      triggerAlarm();
      return;
    }

    const idxList = matchIndexes.map(i => "#" + (i + 1)).join(", ");
    const times = matchIndexes.map(i => formatRecordTime(history[i].data)).join(", ");
    msg += "✅ Hash hợp lệ — khớp blockchain tại " + idxList + ".\n";
    msg += "Thời điểm ghi (record): " + times;
    showResult(out, "ok", msg);
  } catch (e) {
    showResult(out, "err", "Lỗi: " + e.message);
  }
});
