// ============================================================
//  EnergyFlow v3.0 — Production Frontend
//  All data reads from Firebase via backend API
//  Cross-device persistent — no localStorage dependency
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ── YOUR FIREBASE CONFIG (paste yours here) ──────────────────
import { firebaseConfig } from "./firebase.js";
// ─────────────────────────────────────────────────────────────

const BACKEND = "https://electric-meter-in-web.onrender.com";

// ============================================================
//  FIREBASE INIT
// ============================================================
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

let currentToken = null;
let currentUser = null;
let pollInterval = null;
let liveInterval = null;
let billingData = [];
let outageData = [];
let hourlyData = [];
let statView = "today";
let calYear, calMonth;

// ── Chart instances
let dashChart,
  liveVChart,
  liveCChart,
  livePChart,
  hourlyEChart,
  hourlyPChart,
  voltStabChart;

// ── Live ring buffers (for live page only — max 60 pts = 3 min)
const MAX_PTS = 60;
let liveLabels = [],
  liveVoltArr = [],
  liveCurrArr = [],
  livePowArr = [];

// ============================================================
//  AUTH STATE — entry point for everything
// ============================================================
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    currentToken = await user.getIdToken();

    // Refresh token every 50 min (Firebase tokens expire at 60 min)
    setInterval(
      async () => {
        currentToken = await user.getIdToken(true);
      },
      50 * 60 * 1000,
    );

    showApp(user);
  } else {
    currentUser = null;
    currentToken = null;
    showAuth();
  }
});

// ============================================================
//  AUTH UI
// ============================================================
let authMode = "login";

window.switchAuthTab = (mode) => {
  authMode = mode;
  document
    .getElementById("loginTabBtn")
    .classList.toggle("active", mode === "login");
  document
    .getElementById("signupTabBtn")
    .classList.toggle("active", mode === "signup");
  document.getElementById("authSubmitBtn").textContent =
    mode === "login" ? "Sign In" : "Create Account";
  document.getElementById("authSubmitBtn").onclick =
    mode === "login" ? login : signup;
  document.getElementById("authError").textContent = "";
};

window.login = async () => {
  const email = document.getElementById("email").value.trim();
  const pass = document.getElementById("password").value;
  const btn = document.getElementById("authSubmitBtn");
  if (!email || !pass) return setAuthError("Please fill in all fields.");
  btn.textContent = "Signing in…";
  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    setAuthError(friendlyAuthError(e.code));
    btn.textContent = "Sign In";
    btn.disabled = false;
  }
};

window.signup = async () => {
  const email = document.getElementById("email").value.trim();
  const pass = document.getElementById("password").value;
  const btn = document.getElementById("authSubmitBtn");
  if (!email || !pass) return setAuthError("Please fill in all fields.");
  if (pass.length < 6)
    return setAuthError("Password must be at least 6 characters.");
  btn.textContent = "Creating…";
  btn.disabled = true;
  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    toast("Account created! Welcome to EnergyFlow.", "success");
  } catch (e) {
    setAuthError(friendlyAuthError(e.code));
    btn.textContent = "Create Account";
    btn.disabled = false;
  }
};

window.logout = async () => {
  clearAllPolling();
  await signOut(auth);
  toast("Signed out successfully.");
};

function setAuthError(msg) {
  document.getElementById("authError").textContent = msg;
}

function friendlyAuthError(code) {
  const map = {
    "auth/invalid-email": "Invalid email address.",
    "auth/user-not-found": "No account found for this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "An account already exists with this email.",
    "auth/weak-password": "Password is too weak.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/invalid-credential": "Invalid email or password.",
  };
  return map[code] || "Authentication failed. Please try again.";
}

// ============================================================
//  SHOW APP / AUTH
// ============================================================
function showAuth() {
  document.getElementById("authDiv").style.display = "flex";
  document.getElementById("appDiv").style.display = "none";
  document.getElementById("navTabs").style.display = "none";
  document.getElementById("navRight").style.display = "none";
  clearAllPolling();
}

async function showApp(user) {
  document.getElementById("authDiv").style.display = "none";
  document.getElementById("appDiv").style.display = "block";
  document.getElementById("navTabs").style.display = "flex";
  document.getElementById("navRight").style.display = "flex";
  setUserChip(user);
  initCharts();
  await initApp();
}

function setUserChip(user) {
  const email = user.email || "";
  const letter = email.charAt(0).toUpperCase();
  const name = email.split("@")[0];
  document.getElementById("userAvatar").textContent = letter;
  document.getElementById("bigAvatar").textContent = letter;
  document.getElementById("userNameChip").textContent = name;
  document.getElementById("profileEmailDisplay").textContent = email;
  document.getElementById("profileNameDisplay").textContent = name;
}

// ============================================================
//  API HELPER — every request uses Firebase ID token
// ============================================================
async function api(path, opts = {}) {
  if (!currentToken) throw new Error("Not authenticated");
  const res = await fetch(BACKEND + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + currentToken,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================
//  INIT APP
// ============================================================
async function initApp() {
  showPage("dashboard");
  setInterval(updateDashTime, 1000);
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  await Promise.all([
    loadProfile(),
    loadDevices(),
    loadBillingHistory(),
    loadOutages(),
    loadBillingSummary(),
  ]);
  startPolling();
}

function clearAllPolling() {
  clearInterval(pollInterval);
  clearInterval(liveInterval);
  pollInterval = liveInterval = null;
}

function startPolling() {
  clearAllPolling();
  pollLive();
  pollInterval = setInterval(pollLive, 3000); // live data every 3s
  liveInterval = setInterval(() => {
    loadDevices();
    loadOutages();
    renderCalendar();
  }, 30000); // device + outage refresh every 30s
}

// ============================================================
//  NAVIGATION
// ============================================================
window.showPage = (page) => {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.page === page);
  });
  const el = document.getElementById("page-" + page);
  if (el) el.classList.add("active");

  if (page === "prediction") fetchPrediction();
  if (page === "statistics") loadStatisticsPage();
  if (page === "account") loadAccountPage();
  if (page === "charges") loadChargesPage();
};

// ============================================================
//  LIVE DATA POLL — reads from Firebase via backend
// ============================================================
// Tracks when we last got a REAL reading from the ESP
let lastReadingTs = 0; // unix seconds of the last valid ESP reading
let offlineSince = 0; // when we first detected the device went offline (ms)
let offlineTimer = null; // interval that counts up the "offline for Xm Ys" display

async function pollLive() {
  try {
    const d = await api("/live");

    // ── STALENESS CHECK
    // The backend always returns the last stored reading from Firebase,
    // even if the ESP has been off for an hour. We must check the
    // timestamp ourselves. If the reading is >15s old, the device is offline.
    const nowSec = Date.now() / 1000;
    const ageSec = nowSec - (d.timestamp || 0);
    const isStale = ageSec > 15; // no reading in 15s = offline

    if (isStale) {
      // API call worked (backend is up) but ESP is not sending
      handleDeviceOffline(d.timestamp || 0);
    } else {
      // Fresh reading — device is live
      await handleDeviceOnline(d);
    }
  } catch (e) {
    // Backend itself unreachable
    handleDeviceOffline(0);
    updateConnectionPill(false, "Backend offline");
  }
}

async function handleDeviceOnline(d) {
  const nowSec = Math.floor(Date.now() / 1000);

  // ── If we were offline, record the outage now that device is back
  if (offlineSince > 0 && lastReadingTs > 0) {
    const outageStartSec = lastReadingTs; // last known good reading
    const outageEndSec = nowSec;
    const duration = outageEndSec - outageStartSec;

    // Only record if offline for more than 20 seconds (ignore brief network blips)
    if (duration > 20) {
      try {
        // Get device_id from stored devices list
        const devId = window._deviceId || "ESP001";
        await api("/device/outage", {
          method: "POST",
          body: JSON.stringify({
            device_id: devId,
            start_ts: outageStartSec,
            end_ts: outageEndSec,
            duration: duration,
          }),
        });
        console.log("Outage recorded:", {
          devId,
          outageStartSec,
          outageEndSec,
          duration,
        });
        toast(`⚡ Outage recorded — ${fmtDuration(duration)}`, "info");
        // Refresh outage displays
        loadOutages();
      } catch (e) {
        console.warn("Failed to record outage:", e);
      }
    }
  }

  lastReadingTs = d.timestamp || 0;
  offlineSince = 0;
  if (offlineTimer) {
    clearInterval(offlineTimer);
    offlineTimer = null;
  }

  updateConnectionPill(true);
  updateKPIs(d);
  updateDashBillingRow(d);
  updateLivePage(d, false);
  updateSlabIndicator(d.units_used || 0);
  appendDashChart(d);
  clearOfflineBanner();
}

function handleDeviceOffline(lastTs) {
  // Record when we first noticed it went offline
  if (!offlineSince) {
    offlineSince = Date.now();
    // Also store last known reading ts so outage start is accurate
    if (lastTs > 0) lastReadingTs = lastTs;
  }

  updateConnectionPill(false);

  const wipe = ["kpiPower", "kpiVoltage", "kpiPowerSub", "kpiVoltageSub"];
  wipe.forEach((id) => setText(id, "—"));
  setText("kpiPowerSub", "Device offline");
  setText("kpiVoltageSub", "No signal");

  updateLivePage(
    {
      voltage: 0,
      current: 0,
      power: 0,
      energy_kWh: 0,
      total_estimate: 0,
      units_used: 0,
      timestamp: lastTs,
    },
    true,
  );

  showOfflineBanner(lastTs);

  if (!offlineTimer) {
    offlineTimer = setInterval(() => showOfflineBanner(lastTs), 1000);
  }
}

function showOfflineBanner(lastTs) {
  const el = document.getElementById("offlineBanner");
  if (!el) return;

  const durationSec = offlineSince
    ? Math.floor((Date.now() - offlineSince) / 1000)
    : 0;
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const lastSeenStr =
    lastTs > 0
      ? new Date(lastTs * 1000).toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        })
      : "unknown";

  el.style.display = "flex";
  el.innerHTML = `
    <span class="ob-icon">⚡</span>
    <div class="ob-text">
      <strong>Device offline</strong>
      <span>Last seen at ${lastSeenStr} · Offline for <span class="ob-timer">${durationStr}</span></span>
    </div>`;
}

function clearOfflineBanner() {
  const el = document.getElementById("offlineBanner");
  if (el) el.style.display = "none";
}

function updateConnectionPill(ok, label) {
  const dot = document.querySelector(".conn-dot");
  const lbl = document.getElementById("connLabel");
  if (!dot || !lbl) return;
  if (ok) {
    dot.className = "conn-dot live";
    lbl.textContent = "Live";
  } else {
    dot.className = "conn-dot error";
    lbl.textContent = label || "Offline";
  }
}

function updateKPIs(d) {
  setText("kpiPower", fmtNum(d.power, 1));
  setText("kpiVoltage", fmtNum(d.voltage, 1));
  setText("kpiKwh", fmtNum(d.energy_kWh, 3));
  setText("kpiBill", fmtNum(d.total_estimate || 0, 0));
  setText(
    "kpiPowerSub",
    d.power > 0 ? powerLabel(d.power) : "No load detected",
  );
  setText(
    "kpiVoltageSub",
    d.voltage > 0 ? voltageLabel(d.voltage) : "Waiting for device",
  );
  setText("kpiBillSlab", d.slab || "—");
  setText("kpiKwhSub", `${fmtNum(d.units_used || 0, 2)} kWh since last bill`);
}

function updateDashBillingRow(d) {
  const ec = d.bill_amount || 0;
  const fc = d.fixed_charge || 0;
  const duty = ec * 0.15;
  setText("dashUsedUnits", `${fmtNum(d.units_used || 0, 2)} kWh`);
  setText("dashEnergyCharge", `₹${fmtNum(ec, 2)}`);
  setText("dashFixedCharge", `₹${fmtNum(fc, 2)}`);
  setText("dashDuty", `₹${fmtNum(duty, 2)}`);
  setText("dashTotal", `₹${fmtNum(ec + fc + duty, 2)}`);
  // Charges page live estimate (if visible)
  setText("lbUnits", `${fmtNum(d.units_used || 0, 2)} kWh`);
  setText("lbSlab", d.slab || "—");
  setText("lbEnergy", `₹${fmtNum(ec, 2)}`);
  setText("lbFixed", `₹${fmtNum(fc, 2)}`);
  setText("lbDuty", `₹${fmtNum(duty, 2)}`);
  setText("lbTotal", `₹${fmtNum(ec + fc + duty, 2)}`);
  updateChargesSlabPointer(d.units_used || 0);
}

// ============================================================
//  LIVE PAGE
// ============================================================
function updateLivePage(d, isStale = false) {
  const ts = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const bar = document.getElementById("liveStatus");

  if (isStale) {
    // Device offline — wipe gauge values and show offline state
    ["liveVoltage", "liveCurrent", "livePower"].forEach((id) =>
      setText(id, "—"),
    );
    setStatusPillOffline("voltageStatus");
    setStatusPillOffline("currentStatus");
    setStatusPillOffline("powerStatus");
    drawGauge("voltageGauge", 0, 180, 260, "#38bdf8");
    drawGauge("currentGauge", 0, 0, 32, "#fbbf24");
    drawGauge("powerGauge", 0, 0, 7360, "#a78bfa");
    if (bar) {
      bar.innerHTML = `<span class="pulse-dot offline-dot"></span> OFFLINE — no signal`;
      bar.style.color = "var(--red)";
    }
    return; // don't push stale values to charts or log
  }

  setText("liveVoltage", fmtNum(d.voltage, 1));
  setText("liveCurrent", fmtNum(d.current, 3));
  setText("livePower", fmtNum(d.power, 1));
  setText("liveEnergy", fmtNum(d.energy_kWh, 4));
  setText("liveEnergyCost", fmtNum(d.total_estimate || 0, 2));
  setText("liveUnitsUsed", fmtNum(d.units_used || 0, 3));

  // Status pills
  setStatusPill("voltageStatus", d.voltage, 210, 250, "V");
  setStatusPill("currentStatus", d.current, 0, 28, "A");
  setStatusPill("powerStatus", d.power, 0, 6000, "W");

  if (bar) {
    bar.innerHTML = `<span class="pulse-dot"></span> LIVE — ${ts}`;
    bar.style.color = "var(--green)";
  }

  // Arc gauges
  drawGauge("voltageGauge", d.voltage, 180, 260, "#38bdf8");
  drawGauge("currentGauge", d.current, 0, 32, "#fbbf24");
  drawGauge("powerGauge", d.power, 0, 7360, "#a78bfa");

  // Ring buffers for live charts
  if (liveLabels.length >= MAX_PTS) {
    liveLabels.shift();
    liveVoltArr.shift();
    liveCurrArr.shift();
    livePowArr.shift();
  }
  liveLabels.push(ts);
  liveVoltArr.push(d.voltage);
  liveCurrArr.push(d.current);
  livePowArr.push(d.power);
  updateLiveCharts();

  // Append to raw log
  if (d.power > 0 || d.voltage > 0) {
    appendLog(ts, d);
  }
}

function setStatusPillOffline(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = "OFFLINE";
  el.className = "status-pill offline-pill";
}

function setStatusPill(id, val, lo, hi, unit) {
  const el = document.getElementById(id);
  if (!el) return;
  if (val < lo || val > hi) {
    el.className = "status-pill alert";
    el.textContent = "ALERT";
  } else if (val > hi * 0.9) {
    el.className = "status-pill warn";
    el.textContent = "CAUTION";
  } else {
    el.className = "status-pill";
    el.textContent = "NOMINAL";
  }
}

function appendLog(ts, d) {
  const log = document.getElementById("rawLog");
  if (!log) return;
  const warn = d.voltage < 210 || d.voltage > 250;
  const alert = d.voltage < 190 || d.power > 6000;
  const cls = alert ? "log-line alert" : warn ? "log-line warn" : "log-line";
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `[${ts}] V:${fmtNum(d.voltage, 1)}V  I:${fmtNum(d.current, 3)}A  P:${fmtNum(d.power, 1)}W  E:${fmtNum(d.energy_kWh, 4)}kWh`;
  log.prepend(line);
  while (log.children.length > 80) log.removeChild(log.lastChild);
}

window.clearLog = () => {
  const el = document.getElementById("rawLog");
  if (el) el.innerHTML = "";
};

// ============================================================
//  STATISTICS PAGE — all data from Firebase
// ============================================================
window.setStatView = (mode) => {
  statView = mode;
  ["btnToday", "btnYesterday", "btn7d", "btn30d"].forEach((id) => {
    document.getElementById(id)?.classList.remove("active-btn");
  });
  const map = {
    today: "btnToday",
    yesterday: "btnYesterday",
    "7d": "btn7d",
    "30d": "btn30d",
  };
  document.getElementById(map[mode])?.classList.add("active-btn");
  loadStatisticsPage();
};

async function loadStatisticsPage() {
  const days = { today: 1, yesterday: 2, "7d": 7, "30d": 30 }[statView] || 1;
  showLoading(true);
  try {
    const [summary, hourly] = await Promise.all([
      api("/stats/summary"),
      api(`/stats/hourly?days=${days}`)
    ]);
    hourlyData = hourly;

    // KPI bar — from Firebase
    setText(
      "statPeak",
      summary.peak_power ? `${fmtNum(summary.peak_power, 0)}W` : "—",
    );
    setText(
      "statAvg",
      summary.avg_power ? `${fmtNum(summary.avg_power, 0)}W` : "—",
    );
    setText(
      "statMinV",
      summary.min_voltage ? `${fmtNum(summary.min_voltage, 1)}V` : "—",
    );
    setText(
      "statMaxV",
      summary.max_voltage ? `${fmtNum(summary.max_voltage, 1)}V` : "—",
    );
    setText(
      "statTotalEnergy",
      summary.total_energy_today
        ? `${fmtNum(summary.total_energy_today, 3)} kWh`
        : "—",
    );
    setText(
      "statAnomalies",
      summary.anomaly_hours !== undefined ? String(summary.anomaly_hours) : "0",
    );

    // IST date helpers — backend stores dates in IST, we must match
    // new Date().toISOString() gives UTC which can be yesterday at midnight IST
    const istOffset = 5.5 * 60 * 60 * 1000; // 5hr 30min in ms
    const nowIST = new Date(Date.now() + istOffset);
    const todKeyIST = nowIST.toISOString().slice(0, 10);
    const yestIST = new Date(nowIST);
    yestIST.setDate(yestIST.getDate() - 1);
    const yestKeyIST = yestIST.toISOString().slice(0, 10);

    let filtered = hourly;
    if (statView === "yesterday") {
      filtered = hourly.filter((h) => h.date === yestKeyIST);
    } else if (statView === "today") {
      filtered = hourly.filter((h) => h.date === todKeyIST);
    }

    updateStatPeriodLabel();
    renderHourlyCharts(filtered);
    // Legacy frontend ML inference & anomaly log removed.
    renderOutageTable();
  } catch (e) {
    toast("Failed to load statistics: " + e.message, "error");
  } finally {
    showLoading(false);
  }
}

// Format hour number as readable time label
// 0 → "12am", 13 → "1pm", 20 → "8pm"
function fmtHour(h) {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function renderHourlyCharts(data) {
  if (!data || !data.length) {
    // Clear charts when no data
    [hourlyEChart, hourlyPChart, voltStabChart].forEach((c) => {
      if (c) {
        c.data.labels = [];
        c.data.datasets.forEach((d) => (d.data = []));
        c.update();
      }
    });
    return;
  }

  // For multi-day views: label as "Mon 8pm", "Tue 9am" etc
  // For single day: just "8pm"
  const multiDay = statView === "7d" || statView === "30d";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const labels = data.map((h) => {
    const timeStr = fmtHour(h.hour_num);
    if (!multiDay) return timeStr;
    // Show day abbreviation for multi-day
    const d = new Date(h.date + "T00:00:00+05:30"); // parse as IST
    return `${dayNames[d.getDay()]} ${timeStr}`;
  });

  const energies = data.map((h) => h.energy_kwh);
  const powers = data.map((h) => h.avg_power);
  const vMin = data.map((h) => h.min_voltage);
  const vMax = data.map((h) => h.max_voltage);

  // Hourly energy chart
  safeUpdateChart(hourlyEChart, labels, [
    {
      label: "Energy (kWh)",
      data: energies,
      backgroundColor: hexFill("#fbbf24", 0.55),
      borderColor: "#fbbf24",
      borderWidth: 1,
    },
  ]);

  // Hourly power chart
  safeUpdateChart(hourlyPChart, labels, [
    {
      label: "Avg Power (W)",
      data: powers,
      borderColor: "#a78bfa",
      backgroundColor: hexFill("#a78bfa", 0.12),
      tension: 0.4,
      fill: true,
    },
  ]);

  // Voltage stability band
  safeUpdateChart(voltStabChart, labels, [
    {
      label: "Max V",
      data: vMax,
      borderColor: "#38bdf8",
      backgroundColor: "transparent",
      tension: 0.3,
      borderWidth: 1.5,
    },
    {
      label: "Min V",
      data: vMin,
      borderColor: "#f87171",
      backgroundColor: hexFill("#38bdf8", 0.06),
      tension: 0.3,
      fill: "-1",
      borderWidth: 1.5,
    },
  ]);
}

// ============================================================
//  BILLING — all data from Firebase
// ============================================================
async function loadBillingHistory() {
  try {
    billingData = await api("/billing/history");
    renderBillingTable();
    renderCalendar();
  } catch (e) {
    console.error("Billing load error:", e);
  }
}

async function loadBillingSummary() {
  try {
    const s = await api("/billing/summary");
    // Account page
    setEl("accTotalBills", String(s.bill_count || 0));
    setEl("accTotalPaid", `₹${fmtNum(s.total_paid || 0, 0)}`);
    setEl("accTotalUnits", `${fmtNum(s.total_units || 0, 1)} kWh`);
    setEl("accAvgBill", `₹${fmtNum(s.avg_monthly_bill || 0, 0)}`);
    setEl("accHighest", `₹${fmtNum(s.highest_bill || 0, 0)}`);
    // Charges lifetime summary
    if (s.bill_count > 0) {
      document.getElementById("billLifetime").style.display = "grid";
      setText("blTotalPaid", `₹${fmtNum(s.total_paid, 0)}`);
      setText("blTotalUnits", `${fmtNum(s.total_units, 1)} kWh`);
      setText("blAvgBill", `₹${fmtNum(s.avg_monthly_bill, 0)}`);
      setText("blHighest", `₹${fmtNum(s.highest_bill, 0)}`);
      setText(
        "billSummaryBadge",
        `${s.bill_count} bill${s.bill_count !== 1 ? "s" : ""} recorded`,
      );
    }
  } catch (e) {}
}

function renderBillingTable() {
  const tbody = document.getElementById("billingHistoryBody");
  if (!tbody) return;
  const rows = billingData.filter((b) => b.type !== "baseline");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-td">No billing records yet. Take a meter reading to start.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((b, i) => {
      const slabClass =
        b.units <= 100
          ? "green-text"
          : b.units <= 200
            ? "blue-text"
            : b.units <= 500
              ? "amber-text"
              : "red-text";
      return `<tr>
      <td style="color:var(--text-dim)">${rows.length - i}</td>
      <td style="font-size:11px;color:var(--text-dim)">${b.from_date || "—"} → ${b.to_date || "—"}</td>
      <td><span class="mono">${fmtNum(b.units, 2)}</span></td>
      <td class="mono amber-text">₹${fmtNum(b.energy_charge || 0, 2)}</td>
      <td class="mono">₹${fmtNum(b.fixed_charge || 0, 2)}</td>
      <td class="mono">₹${fmtNum(b.duty || 0, 2)}</td>
      <td class="mono amber-text" style="font-weight:700">₹${fmtNum(b.total || 0, 2)}</td>
      <td><span class="${slabClass}" style="font-size:10px">${b.slab || "—"}</span></td>
    </tr>`;
    })
    .join("");
}

window.takeReading = async () => {
  const btn = document.getElementById("takeBtn");
  if (btn) {
    btn.textContent = "Recording…";
    btn.disabled = true;
  }
  try {
    const r = await api("/billing/take-reading", { method: "POST" });
    toast(
      `✓ Reading recorded — ${fmtNum(r.units || 0, 2)} kWh used`,
      "success",
    );
    await Promise.all([loadBillingHistory(), loadBillingSummary()]);
  } catch (e) {
    toast("Failed: " + e.message, "error");
  } finally {
    if (btn) {
      btn.textContent = "Take Reading";
      btn.disabled = false;
    }
  }
};

// ============================================================
//  OUTAGES — all data from Firebase
// ============================================================
async function loadOutages() {
  try {
    const [list, stats] = await Promise.all([
      api("/outages"),
      api("/outages/stats"),
    ]);
    outageData = list || [];

    // Dashboard
    setTextColor(
      "oTotal",
      String(stats.total_outages || 0),
      stats.total_outages > 0 ? "ostat-val red-text" : "ostat-val green-text",
    );
    setText("oDowntime", fmtMin(stats.total_downtime_min || 0));
    setText("oLongest", fmtMin(stats.longest_min || 0));
    setText("oAvg", fmtMin(stats.avg_duration_min || 0));
    setText("outageBadge", `${stats.total_outages || 0} total`);

    // Account page
    setEl("accOutages", String(stats.total_outages || 0));

    renderDashOutageList();
    renderOutageTable();
  } catch (e) {
    console.error("Outage load error:", e);
  }
}

function fmtMin(min) {
  if (!min || min < 0.1) return "0 min";
  if (min < 1) return `${Math.round(min * 60)}s`;
  return min >= 60
    ? `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`
    : `${fmtNum(min, 1)} min`;
}

function renderDashOutageList() {
  const el = document.getElementById("dashOutageList");
  if (!el) return;
  if (!outageData.length) {
    el.innerHTML = `<div class="empty-state" style="padding:8px">✓ No power outages recorded</div>`;
    return;
  }
  el.innerHTML = outageData
    .slice(0, 5)
    .map((o) => {
      const start = new Date(o.start_ts * 1000).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const dur = fmtMin(o.duration_min);
      return `<div class="outage-row">
      <span class="or-time">🕒 ${start}</span>
      <span class="or-dur">⏱ ${dur}</span>
      <span class="or-ok">✓ Restored</span>
    </div>`;
    })
    .join("");
}

function renderOutageTable() {
  const tbody = document.getElementById("outageTableBody");
  if (!tbody) return;
  if (!outageData.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-td">No power outages recorded — excellent!</td></tr>`;
    return;
  }
  tbody.innerHTML = outageData
    .map((o, i) => {
      const start = new Date(o.start_ts * 1000).toLocaleString("en-IN");
      const restored = new Date(o.end_ts * 1000).toLocaleString("en-IN");
      const dur =
        o.duration < 60
          ? `${o.duration}s`
          : `${Math.floor(o.duration / 60)}m ${o.duration % 60}s`;
      return `<tr>
      <td style="color:var(--text-dim)">${i + 1}</td>
      <td style="color:var(--red);font-size:12px">${start}</td>
      <td style="color:var(--green);font-size:12px">${restored}</td>
      <td style="font-weight:700;color:var(--amber);font-family:'Space Mono',monospace">${dur}</td>
      <td style="color:var(--blue);font-size:11px">↺ Energy counter reset</td>
    </tr>`;
    })
    .join("");
}

// ============================================================
//  DEVICES
// ============================================================
async function loadDevices() {
  try {
    const devices = await api("/devices");
    renderDeviceList(devices);
    renderAccountDevices(devices);
  } catch (e) {}
}

function renderDeviceList(devices) {
  // Cache first device_id for outage recording
  if (devices && devices.length > 0) window._deviceId = devices[0].device_id;
  const el = document.getElementById("deviceList");
  if (!el) return;
  if (!devices.length) {
    el.innerHTML = `<div class="empty-state">No device registered yet.<br><button class="btn-primary-sm" style="margin-top:8px" onclick="openDeviceModal()">+ Register ESP32</button></div>`;
    return;
  }
  el.innerHTML = devices
    .map((d) => {
      const stale = Date.now() / 1000 - d.last_seen > 30;
      const statusC = stale ? "ds-inactive" : "ds-active";
      const statusL = stale ? "OFFLINE" : "ONLINE";
      const ago = d.last_seen ? timeSince(d.last_seen) + " ago" : "Never";
      return `<div class="device-item">
      <div>
        <div class="di-id">📡 ${d.device_id}</div>
        <div class="di-info">Last seen: ${ago} · ${fmtNum(d.power || 0, 0)}W · ${fmtNum(d.voltage || 0, 1)}V</div>
      </div>
      <span class="device-status ${statusC}">${statusL}</span>
    </div>`;
    })
    .join("");
}

function renderAccountDevices(devices) {
  const el = document.getElementById("accountDeviceList");
  if (!el) return;
  if (!devices.length) {
    el.innerHTML = `<div class="empty-state">No device registered.</div>`;
    return;
  }
  el.innerHTML = devices
    .map((d) => {
      const stale = Date.now() / 1000 - d.last_seen > 30;
      return `<div class="device-item">
      <div>
        <div class="di-id">📡 ${d.device_id}</div>
        <div class="di-info">Registered · Last seen: ${timeSince(d.last_seen)} ago</div>
      </div>
      <span class="device-status ${stale ? "ds-inactive" : "ds-active"}">${stale ? "OFFLINE" : "LIVE"}</span>
    </div>`;
    })
    .join("");
}

window.openDeviceModal = () => {
  document.getElementById("deviceModal").style.display = "flex";
};
window.closeDeviceModal = () => {
  document.getElementById("deviceModal").style.display = "none";
};

window.registerDevice = async () => {
  const id = document.getElementById("deviceId").value.trim();
  if (!id) return toast("Enter a Device ID", "error");
  try {
    await api(`/register-device?device_id=${encodeURIComponent(id)}`, {
      method: "POST",
    });
    toast(`✓ Device ${id} registered!`, "success");
    closeDeviceModal();
    loadDevices();
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
};

// ============================================================
//  PROFILE
// ============================================================
async function loadProfile() {
  try {
    const p = await api("/user/profile");
    if (p.display_name) {
      setText("profileNameDisplay", p.display_name);
      setText("userNameChip", p.display_name.split(" ")[0]);
      document.getElementById("bigAvatar").textContent = p.display_name
        .charAt(0)
        .toUpperCase();
      document.getElementById("userAvatar").textContent = p.display_name
        .charAt(0)
        .toUpperCase();
    }
    setVal("pfName", p.display_name || "");
    setVal("pfPhone", p.phone || "");
    setVal("pfAddress", p.address || "");
    setVal("pfEbNo", p.eb_consumer_no || "");
    setVal("pfTariff", p.tariff_type || "LT-I");
    setVal("pfLoad", p.sanctioned_load || "");
  } catch (e) {}
}

window.saveProfile = async () => {
  try {
    const profile = {
      display_name: getVal("pfName"),
      phone: getVal("pfPhone"),
      address: getVal("pfAddress"),
      eb_consumer_no: getVal("pfEbNo"),
      tariff_type: getVal("pfTariff"),
      sanctioned_load: parseFloat(getVal("pfLoad")) || null,
    };
    await api("/user/profile", {
      method: "POST",
      body: JSON.stringify(profile),
    });
    toast("✓ Profile saved to Firebase", "success");
    loadProfile();
  } catch (e) {
    toast("Save failed: " + e.message, "error");
  }
};

// ============================================================
//  ACCOUNT PAGE
// ============================================================
function loadAccountPage() {
  loadProfile();
  loadDevices();
  loadBillingSummary();
  loadOutages();
}

// ============================================================
//  CHARGES PAGE
// ============================================================
function loadChargesPage() {
  loadBillingHistory();
  loadBillingSummary();
}

// ============================================================
//  MANUAL BILL CALCULATOR
// ============================================================
window.calcBill = () => {
  const units = parseFloat(document.getElementById("calcUnits")?.value) || 0;
  const months = parseInt(document.getElementById("calcMonths")?.value) || 1;
  if (units <= 0) {
    document.getElementById("calcResult").style.display = "none";
    return;
  }

  const result = calcBillFull(units);
  const lines = [
    { label: "Units consumed", val: `${fmtNum(units, 2)} kWh` },
    { label: "Energy charges", val: `₹${fmtNum(result.energy, 2)}` },
    {
      label: `Fixed charge × ${months} month${months > 1 ? "s" : ""}`,
      val: `₹${fmtNum(result.fixed * months, 2)}`,
    },
    { label: "Electricity duty (15%)", val: `₹${fmtNum(result.duty, 2)}` },
    { label: "Slab", val: result.slab },
  ];

  const total = result.energy + result.fixed * months + result.duty;
  document.getElementById("calcLines").innerHTML = lines
    .map(
      (l) =>
        `<div class="calc-line"><span>${l.label}</span><span class="mono">${l.val}</span></div>`,
    )
    .join("");
  setText("calcGrandTotal", `₹${fmtNum(total, 2)}`);
  document.getElementById("calcResult").style.display = "block";
};

function calcBillFull(units) {
  // TNEB LT-I Domestic — 7-slab progressive tariff (monthly)
  if (units <= 0)
    return { energy: 0, fixed: 45, duty: 0, total: 45, slab: "Slab 1 \u2014 Free (0\u201350 units)" };
  let energy = 0;
  if (units > 50)  energy += Math.min(units - 50,  150) * 4.70;   // 51\u2013200
  if (units > 200) energy += Math.min(units - 200,  50) * 6.30;   // 201\u2013250
  if (units > 250) energy += Math.min(units - 250,  50) * 8.40;   // 251\u2013300
  if (units > 300) energy += Math.min(units - 300, 100) * 9.45;   // 301\u2013400
  if (units > 400) energy += Math.min(units - 400, 100) * 10.50;  // 401\u2013500
  if (units > 500) energy += (units - 500)               * 11.55; // Above 500
  const fixed =
    units <= 100 ? 45 : units <= 200 ? 75 : units <= 500 ? 115 : 155;
  const duty = energy * 0.15;
  const total = energy + fixed + duty;
  const slab =
    units <= 50
      ? "Slab 1 \u2014 Free (0\u201350 units)"
      : units <= 200
        ? "Slab 2 \u2014 \u20b94.70/unit (51\u2013200)"
        : units <= 250
          ? "Slab 3 \u2014 \u20b96.30/unit (201\u2013250)"
          : units <= 300
            ? "Slab 4 \u2014 \u20b98.40/unit (251\u2013300)"
            : units <= 400
              ? "Slab 5 \u2014 \u20b99.45/unit (301\u2013400)"
              : units <= 500
                ? "Slab 6 \u2014 \u20b910.50/unit (401\u2013500)"
                : "Slab 7 \u2014 \u20b911.55/unit (Above 500)";
  return {
    energy: Math.round(energy * 100) / 100,
    fixed,
    duty: Math.round(duty * 100) / 100,
    total: Math.round(total * 100) / 100,
    slab,
  };
}

function updateChargesSlabPointer(units) {
  // 7 slab bands, each ~14.3% of the visual track
  const pct =
    units <= 50
      ? (units / 50) * 14.3
      : units <= 200
        ? 14.3 + ((units - 50) / 150) * 14.3
        : units <= 250
          ? 28.6 + ((units - 200) / 50) * 14.3
          : units <= 300
            ? 42.9 + ((units - 250) / 50) * 14.3
            : units <= 400
              ? 57.2 + ((units - 300) / 100) * 14.3
              : units <= 500
                ? 71.5 + ((units - 400) / 100) * 14.3
                : Math.min(100, 85.8 + ((units - 500) / 300) * 14.2);
  const ptr = document.getElementById("svPtr");
  if (ptr) ptr.style.marginLeft = `calc(${pct}% - 6px)`;
}

// ============================================================
//  BILLING CALENDAR
// ============================================================
function renderCalendar() {
  const grid = document.getElementById("calendarGrid");
  const mon = document.getElementById("calendarMonth");
  if (!grid || !mon) return;

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  mon.textContent = `${monthNames[calMonth]} ${calYear}`;

  const first = new Date(calYear, calMonth, 1).getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();

  const billMap = {};
  billingData.forEach((b) => {
    if (!b.to_date) return;
    const date = b.to_date.slice(0, 10);
    if (!billMap[date]) billMap[date] = 0;
    billMap[date] += b.total || 0;
  });

  let html = "";
  for (let i = 0; i < first; i++)
    html += `<div class="cal-day" style="opacity:.2"></div>`;
  for (let d = 1; d <= days; d++) {
    const key = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const amt = billMap[key];
    html += `<div class="cal-day ${amt ? "has-bill" : ""}">
      <span class="cal-num">${d}</span>
      ${amt ? `<span class="cal-amt">₹${fmtNum(amt, 0)}</span>` : ""}
    </div>`;
  }
  grid.innerHTML = html;
}

window.prevMonth = () => {
  calMonth--;
  if (calMonth < 0) {
    calMonth = 11;
    calYear--;
  }
  renderCalendar();
};
window.nextMonth = () => {
  calMonth++;
  if (calMonth > 11) {
    calMonth = 0;
    calYear++;
  }
  renderCalendar();
};

// ============================================================
//  SLAB INDICATOR (dashboard)
// ============================================================
function updateSlabIndicator(units) {
  // 7 slab bands, each ~14.3% of the visual track
  const pct =
    units <= 50
      ? (units / 50) * 14.3
      : units <= 200
        ? 14.3 + ((units - 50) / 150) * 14.3
        : units <= 250
          ? 28.6 + ((units - 200) / 50) * 14.3
          : units <= 300
            ? 42.9 + ((units - 250) / 50) * 14.3
            : units <= 400
              ? 57.2 + ((units - 300) / 100) * 14.3
              : units <= 500
                ? 71.5 + ((units - 400) / 100) * 14.3
                : Math.min(100, 85.8 + ((units - 500) / 300) * 14.2);
  const needle = document.getElementById("slabNeedle");
  if (needle) needle.style.marginLeft = `calc(${pct}% - 5px)`;
}

// ============================================================
//  EXPORT — CSV download from Firebase data
// ============================================================
window.exportCSV = async () => {
  toast("Preparing CSV…");
  try {
    const data = await api("/export/csv?days=30");
    const cols = [
      "hour",
      "date",
      "hour_num",
      "avg_voltage",
      "avg_current",
      "avg_power",
      "max_power",
      "min_voltage",
      "max_voltage",
      "energy_kwh",
      "samples",
    ];
    const csv = [
      cols.join(","),
      ...data.map((r) => cols.map((c) => r[c] ?? "").join(",")),
    ].join("\n");
    downloadBlob(csv, "energyflow_hourly.csv", "text/csv");
    toast("✓ Hourly data exported!", "success");
  } catch (e) {
    toast("Export failed: " + e.message, "error");
  }
};

window.exportBillingCSV = async () => {
  if (!billingData.length) {
    toast("No billing data to export", "error");
    return;
  }
  const cols = [
    "from_date",
    "to_date",
    "units",
    "energy_charge",
    "fixed_charge",
    "duty",
    "total",
    "slab",
  ];
  const csv = [
    cols.join(","),
    ...billingData
      .filter((b) => b.type !== "baseline")
      .map((b) => cols.map((c) => b[c] ?? "").join(",")),
  ].join("\n");
  downloadBlob(csv, "energyflow_billing.csv", "text/csv");
  toast("✓ Billing history exported!", "success");
};

window.exportOutagesCSV = async () => {
  if (!outageData.length) {
    toast("No outage data to export", "error");
    return;
  }
  const cols = [
    "start_human",
    "end_human",
    "duration",
    "duration_min",
    "device_id",
  ];
  const csv = [
    cols.join(","),
    ...outageData.map((o) => cols.map((c) => o[c] ?? "").join(",")),
  ].join("\n");
  downloadBlob(csv, "energyflow_outages.csv", "text/csv");
  toast("✓ Outage log exported!", "success");
};

function downloadBlob(content, filename, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
}

// ============================================================
//  DASHBOARD TIME & GREETING
// ============================================================
function updateDashTime() {
  const now = new Date();
  setText("dashTime", now.toLocaleTimeString("en-IN"));
  const h = now.getHours();
  const g =
    h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  setText(
    "dashGreeting",
    `${g} — ${now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}`,
  );
}

// ============================================================
//  CHARTS — init all chart instances
// ============================================================
function initCharts() {
  Chart.defaults.color = "#64748b";
  Chart.defaults.borderColor = "rgba(255,255,255,0.05)";
  Chart.defaults.font.family = "'Exo 2', sans-serif";
  Chart.defaults.animation = { duration: 400 };

  const baseOpts = (yLabel) => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: "index",
        intersect: false,
        backgroundColor: "rgba(6,12,20,0.95)",
        borderColor: "rgba(251,191,36,0.2)",
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(255,255,255,0.03)" },
        ticks: { maxTicksLimit: 8 },
      },
      y: {
        grid: { color: "rgba(255,255,255,0.04)" },
        ticks: { callback: (v) => `${v}${yLabel}` },
      },
    },
  });

  // Dashboard dual-axis chart
  const dCtx = document.getElementById("dashPowerChart")?.getContext("2d");
  if (dCtx)
    dashChart = new Chart(dCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Power (W)",
            data: [],
            borderColor: "#fbbf24",
            backgroundColor: hexFill("#fbbf24", 0.08),
            tension: 0.4,
            fill: true,
            yAxisID: "yP",
          },
          {
            label: "Voltage (V)",
            data: [],
            borderColor: "#38bdf8",
            backgroundColor: "transparent",
            tension: 0.4,
            yAxisID: "yV",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            backgroundColor: "rgba(6,12,20,0.95)",
            borderColor: "rgba(251,191,36,0.15)",
            borderWidth: 1,
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
          yP: {
            position: "left",
            grid: { color: "rgba(255,255,255,0.03)" },
            ticks: { callback: (v) => `${v}W` },
          },
          yV: {
            position: "right",
            grid: { display: false },
            min: 180,
            max: 260,
            ticks: { callback: (v) => `${v}V` },
          },
        },
      },
    });

  // Live charts
  liveVChart = makeLineChart("liveVoltageChart", "Voltage (V)", "#38bdf8");
  liveCChart = makeLineChart("liveCurrentChart", "Current (A)", "#fbbf24");
  livePChart = makeLineChart("livePowerChart", "Power (W)", "#a78bfa");

  // Statistics charts
  hourlyEChart = makeBarChart("hourlyEnergyChart", "Energy (kWh)", "#fbbf24");
  hourlyPChart = makeLineChart("hourlyPowerChart", "Power (W)", "#a78bfa");
  voltStabChart = makeLineChart(
    "voltageStabilityChart",
    "Voltage (V)",
    "#38bdf8",
  );
}

function makeLineChart(id, label, color) {
  const ctx = document.getElementById(id)?.getContext("2d");
  if (!ctx) return null;
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label,
          data: [],
          borderColor: color,
          backgroundColor: hexFill(color, 0.1),
          tension: 0.4,
          fill: true,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { grid: { color: "rgba(255,255,255,0.04)" } },
      },
    },
  });
}

function makeBarChart(id, label, color) {
  const ctx = document.getElementById(id)?.getContext("2d");
  if (!ctx) return null;
  return new Chart(ctx, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label,
          data: [],
          backgroundColor: hexFill(color, 0.55),
          borderColor: color,
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: "rgba(255,255,255,0.04)" } },
      },
    },
  });
}

function appendDashChart(d) {
  if (!dashChart) return;
  const ts = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const c = dashChart.data;
  if (c.labels.length > MAX_PTS) {
    c.labels.shift();
    c.datasets[0].data.shift();
    c.datasets[1].data.shift();
  }
  c.labels.push(ts);
  c.datasets[0].data.push(d.power || 0);
  c.datasets[1].data.push(d.voltage || 0);
  dashChart.update("none");
}

function updateLiveCharts() {
  // update("none") skips animation entirely — critical for 3s refresh speed
  if (liveVChart) {
    liveVChart.data.labels = liveLabels;
    liveVChart.data.datasets[0].data = liveVoltArr;
    liveVChart.update("none");
  }
  if (liveCChart) {
    liveCChart.data.labels = liveLabels;
    liveCChart.data.datasets[0].data = liveCurrArr;
    liveCChart.update("none");
  }
  if (livePChart) {
    livePChart.data.labels = liveLabels;
    livePChart.data.datasets[0].data = livePowArr;
    livePChart.update("none");
  }
}

function safeUpdateChart(chart, labels, datasets) {
  if (!chart) return;
  chart.data.labels = labels; // direct ref is fine — chart reads on update()
  datasets.forEach((ds, i) => {
    if (chart.data.datasets[i]) {
      chart.data.datasets[i].data = ds.data; // no spread — avoids GC churn
      if (ds.label) chart.data.datasets[i].label = ds.label;
      if (ds.borderColor) chart.data.datasets[i].borderColor = ds.borderColor;
      if (ds.backgroundColor)
        chart.data.datasets[i].backgroundColor = ds.backgroundColor;
      if (ds.fill !== undefined) chart.data.datasets[i].fill = ds.fill;
    }
  });
  chart.update("none");
}

// ============================================================
//  ARC GAUGES (canvas)
// ============================================================
function drawGauge(id, value, min, max, color) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width,
    H = canvas.height;
  const cx = W / 2,
    cy = H * 0.9;
  const R = W * 0.42;
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const pct = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const valAngle = startAngle + pct * Math.PI;

  ctx.clearRect(0, 0, W, H);

  // Track
  ctx.beginPath();
  ctx.arc(cx, cy, R, startAngle, endAngle);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.stroke();

  // Fill
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, color + "60");
  grad.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(cx, cy, R, startAngle, valAngle);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 10;
  ctx.stroke();

  // Tick marks
  for (let i = 0; i <= 10; i++) {
    const ang = startAngle + (i / 10) * Math.PI;
    const ir = R - 14,
      or = R - 8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * ir, cy + Math.sin(ang) * ir);
    ctx.lineTo(cx + Math.cos(ang) * or, cy + Math.sin(ang) * or);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Needle
  const nx = cx + Math.cos(valAngle) * (R - 16);
  const ny = cy + Math.sin(valAngle) * (R - 16);
  ctx.beginPath();
  ctx.arc(nx, ny, 4, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fill();
}

// ============================================================
//  TOAST
// ============================================================
window.toast = (msg, type = "") => {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove("show"), 3200);
};

// ============================================================
//  LOADING OVERLAY
// ============================================================
function showLoading(on) {
  const el = document.getElementById("loadingOverlay");
  if (el) el.style.display = on ? "flex" : "none";
}

// ============================================================
//  HELPERS
// ============================================================
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setEl(id, val) {
  setText(id, val);
}
function setTextColor(id, val, cls) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = val;
    el.className = cls;
  }
}
function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}
function getVal(id) {
  return document.getElementById(id)?.value || "";
}
function fmtNum(n, dec) {
  return (n || 0).toFixed(dec);
}

function hexFill(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function timeSince(ts) {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function powerLabel(p) {
  if (p < 50) return "Standby / Idle";
  if (p < 500) return "Light load";
  if (p < 2000) return "Medium load (AC/Fan)";
  if (p < 5000) return "Heavy load (Cooking)";
  return "Very heavy — check appliances";
}

function voltageLabel(v) {
  if (v < 190) return "⚠ Critical — very low voltage";
  if (v < 210) return "⚠ Low voltage — check supply";
  if (v <= 250) return "✓ Nominal range";
  if (v <= 260) return "⚠ High voltage — monitor";
  return "🚨 Critically high — switch off";
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

// ── Expose needed functions globally
window.showPage = window.showPage;
window.prevMonth = window.prevMonth;
window.nextMonth = window.nextMonth;
window.openDeviceModal = window.openDeviceModal;
window.registerDevice = window.registerDevice;
window.closeDeviceModal = window.closeDeviceModal;
window.takeReading = window.takeReading;
window.calcBill = window.calcBill;
window.exportCSV = window.exportCSV;
window.exportBillingCSV = window.exportBillingCSV;
window.exportOutagesCSV = window.exportOutagesCSV;
window.saveProfile = window.saveProfile;
window.setStatView = window.setStatView;
window.clearLog = window.clearLog;
window.switchAuthTab = window.switchAuthTab;
window.toggleML = window.toggleML;
window.switchStatTab = window.switchStatTab;
window.login = window.login;
window.signup = window.signup;
window.logout = window.logout;

// ============================================================
//  STATISTICS PAGE HELPERS
// ============================================================

// Toggle ML section open/closed
window.toggleML = () => {
  const body = document.getElementById("mlBody");
  const icon = document.getElementById("mlToggleIcon");
  if (!body) return;
  const open = body.style.display === "block";
  body.style.display = open ? "none" : "block";
  if (icon) icon.textContent = open ? "▼ show" : "▲ hide";
};

// Switch between Anomalies and Outages tabs on Statistics page
window.switchStatTab = (tab) => {
  const paneA = document.getElementById("tabPaneAnomaly");
  const paneO = document.getElementById("tabPaneOutage");
  const btnA = document.getElementById("tabAnomaly");
  const btnO = document.getElementById("tabOutage");
  if (tab === "anomaly") {
    if (paneA) paneA.style.display = "block";
    if (paneO) paneO.style.display = "none";
    btnA?.classList.add("active-tab");
    btnO?.classList.remove("active-tab");
  } else {
    if (paneA) paneA.style.display = "none";
    if (paneO) paneO.style.display = "block";
    btnA?.classList.remove("active-tab");
    btnO?.classList.add("active-tab");
    renderOutageTable();
  }
};

// Update the sub-heading to show period + IST label
function updateStatPeriodLabel() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + istOffset);
  const timeStr = nowIST.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const labels = {
    today: `Today · as of ${timeStr} IST`,
    yesterday: `Yesterday · IST`,
    "7d": `Last 7 days · IST`,
    "30d": `Last 30 days · IST`,
  };
  setText("statPeriodLabel", labels[statView] || "IST");
}

// ============================================================
//  PREDICTION PAGE — All 6 ML Models
// ============================================================

let loadDoughnutChartInst = null;
let forecastChartInst = null;

// Orchestrator — called by showPage('prediction')
window.fetchPrediction = () => loadPredictionPage();

window.loadPredictionPage = async () => {
  await Promise.allSettled([
    fetchNilm(),
    fetchEnergyCost(),
    fetchVoltageFluctuation(),
  ]);
};

// ── 6. NILM — Appliance Disaggregation
let nilmDoughnutInst = null;

async function fetchNilm() {
  const gridEl = document.getElementById('nilmApplianceGrid');
  const metaEl = document.getElementById('nilmMeta');
  if (!gridEl) return;
  gridEl.innerHTML = '<div class="skeleton-item"></div><div class="skeleton-item" style="margin-top:8px;opacity:0.6"></div>';
  try {
    const d = await api('/ml/nilm?days=7');
    if (d.error) {
      gridEl.innerHTML = `<div class="empty-state" style="color:var(--red)">${d.error}</div>`;
      return;
    }
    if (metaEl) {
      metaEl.textContent = `Analysed ${d.hours_analyzed}h over ${d.days_analyzed} days · Total measured: ${d.total_measured_kwh} kWh · Avg: ${d.avg_measured_watts}W`;
    }

    // Render appliance cards
    const colorMap = {
      'Refrigerator':    '#38bdf8',
      'Ceiling Fan':     '#34d399',
      'Air Conditioner': '#f87171',
      'Lights / LED':    '#fbbf24',
      'Television':      '#a78bfa',
      'Water Heater':    '#fb923c',
      'Washing Machine': '#e879f9',
      'Miscellaneous':   '#64748b',
    };
    gridEl.innerHTML = d.appliances.map(a => {
      const col = colorMap[a.name] || '#94a3b8';
      return `<div class="appliance-card" style="border-left:3px solid ${col}">
        <div class="ac-left">
          <span class="ac-icon">${a.icon}</span>
          <div>
            <div class="ac-name">${a.name}</div>
            <div class="ac-watts">${a.estimated_watts}W · ${a.run_hours_per_day}h/day</div>
          </div>
        </div>
        <div class="ac-right">
          <div class="ac-kwh">${a.estimated_daily_kwh} <span class="ac-kwh-unit">kWh/day</span></div>
          <div class="ac-monthly">${a.estimated_monthly_kwh} kWh/mo</div>
          <div class="ac-pct-bar"><div style="width:${a.percent_share}%;background:${col}"></div></div>
          <div class="ac-pct-lbl">${a.percent_share}%</div>
        </div>
      </div>`;
    }).join('');

    // NILM doughnut chart
    const labels = d.appliances.map(a => a.name);
    const vals   = d.appliances.map(a => a.estimated_daily_kwh);
    const colors = d.appliances.map(a => colorMap[a.name] || '#94a3b8');

    if (nilmDoughnutInst) { nilmDoughnutInst.destroy(); nilmDoughnutInst = null; }
    const ctx = document.getElementById('nilmDoughnutChart');
    if (ctx) {
      nilmDoughnutInst = new Chart(ctx.getContext('2d'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '60%',
          plugins: {
            legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 10, padding: 6 } }
          }
        }
      });
    }

    // Store avg daily kWh for energy cost calculator reference
    window._nilmAvgDailyKwh = d.avg_daily_kwh;

  } catch(e) {
    gridEl.innerHTML = `<div class="empty-state" style="color:var(--red)">NILM Error: ${e.message}</div>`;
  }
}

// ── 7. Energy Cost Calculator
let _ecCooldown = null;

window.onEnergyCostInput = () => {
  clearTimeout(_ecCooldown);
  _ecCooldown = setTimeout(fetchEnergyCost, 500);
};

async function fetchEnergyCost() {
  const periodEl = document.getElementById('ecPeriod');
  const kwhEl    = document.getElementById('ecKwh');
  const slabEl   = document.getElementById('ecSlabBreakdown');
  const totalEl  = document.getElementById('ecTotalRow');
  const noteEl   = document.getElementById('ecMlNote');
  const saveEl   = document.getElementById('ecSavings');
  const refEl    = document.getElementById('ecPredRefBody');
  if (!periodEl) return;

  const period = periodEl.value;
  const kwhVal = kwhEl ? kwhEl.value : '';
  let url = `/ml/energy-cost?period=${period}`;
  if (kwhVal) url += `&kwh=${kwhVal}`;

  if (slabEl) slabEl.innerHTML = '<div class="skeleton-item" style="height:24px;"></div>';
  if (totalEl) totalEl.style.display = 'none';
  if (saveEl) saveEl.style.display = 'none';

  try {
    const d = await api(url);
    if (d.error) {
      if (slabEl) slabEl.innerHTML = `<div class="empty-state" style="color:var(--red)">${d.error}</div>`;
      return;
    }

    // Source note
    const srcMap = { user_input: '✏️ Manual input', xgboost_prediction: '🤖 XGBoost prediction', nilm_estimate: '🔍 NILM estimate' };
    if (noteEl) {
      noteEl.textContent = `Source: ${srcMap[d.kwh_source] || d.kwh_source} · ${d.kwh_input} kWh for ${d.months === 2 ? 'bi-monthly' : 'monthly'} period`;
    }

    // Slab breakdown
    if (slabEl) {
      slabEl.innerHTML = d.slab_breakdown.map(s => `
        <div class="ec-slab-row">
          <span class="ec-slab-name">${s.slab}</span>
          <span class="ec-slab-rate">${s.rate}</span>
          <span class="ec-slab-units">${s.units} kWh</span>
          <span class="ec-slab-charge">₹${s.charge}</span>
        </div>`).join('') +
        `<div class="ec-slab-row ec-slab-summary">
          <span>Fixed Charge</span><span></span><span></span><span>₹${d.fixed_charge}</span>
        </div>
        <div class="ec-slab-row ec-slab-summary">
          <span>Electricity Duty (15%)</span><span></span><span></span><span>₹${d.electricity_duty}</span>
        </div>`;
    }

    // Total
    if (totalEl) {
      document.getElementById('ecTotal').textContent = d.total_bill.toLocaleString('en-IN');
      document.getElementById('ecSubLine').textContent = `${d.slab_label} · Energy ₹${d.energy_charge} + Fixed ₹${d.fixed_charge} + Duty ₹${d.electricity_duty}`;
      totalEl.style.display = 'block';
    }

    // Savings row
    if (saveEl) {
      document.getElementById('ecSave').textContent = `₹${d.savings_if_10pct_less}`;
      document.getElementById('ecExtra').textContent = `₹${d.extra_if_10pct_more}`;
      saveEl.style.display = 'flex';
    }

    // Reference card — ML predicted kWh comparison
    if (refEl) {
      const nilmMonthly = window._nilmAvgDailyKwh ? (window._nilmAvgDailyKwh * 30).toFixed(3) : '—';
      refEl.innerHTML = `
        <div class="pred-ref-row"><span>Your input (${d.months === 2 ? 'bi-monthly' : 'monthly'})</span><strong>${d.kwh_input} kWh</strong></div>
        ${d.ml_predicted_kwh ? `<div class="pred-ref-row"><span>XGBoost monthly prediction</span><strong style="color:var(--amber)">${d.ml_predicted_kwh} kWh</strong></div>` : ''}
        <div class="pred-ref-row"><span>NILM estimated monthly</span><strong style="color:var(--blue)">${nilmMonthly} kWh</strong></div>
        <div class="pred-ref-row"><span>Total estimated bill</span><strong style="color:var(--green)">₹${d.total_bill.toLocaleString('en-IN')}</strong></div>
        <div style="margin-top:10px;font-size:11px;color:var(--text-dim);">
          💡 If you reduce usage by 10%, you save <strong style="color:var(--green)">₹${d.savings_if_10pct_less}</strong>.
          A 10% increase adds <strong style="color:var(--red)">₹${d.extra_if_10pct_more}</strong>.
        </div>`;
    }

  } catch(e) {
    if (slabEl) slabEl.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// ── 8. Voltage Fluctuation Predictor
let vfHistChartInst = null;

async function fetchVoltageFluctuation() {
  const bodyEl   = document.getElementById('vfBody');
  const badgeEl  = document.getElementById('vfAlertBadge');
  const meterEl  = document.getElementById('vfMeterWrap');
  const eventsEl = document.getElementById('vfEventsWrap');
  const vsiBarEl = document.getElementById('vfVsiBar');
  const vsiLblEl = document.getElementById('vfVsiLabel');
  const evBodyEl = document.getElementById('vfEventsBody');
  if (!bodyEl) return;

  bodyEl.innerHTML = '<div class="skeleton-item"></div>';
  try {
    const d = await api('/ml/voltage-fluctuation?days=7');
    if (d.error) {
      bodyEl.innerHTML = `<div class="empty-state" style="color:var(--red)">${d.error}</div>`;
      return;
    }

    // Alert badge
    if (badgeEl) {
      const bColors = { GREEN: '#34d399', YELLOW: '#fbbf24', RED: '#f87171' };
      const col = bColors[d.alert_level] || '#94a3b8';
      badgeEl.textContent = `${d.alert_emoji} ${d.alert_level}`;
      badgeEl.style.cssText = `background:${col}20;color:${col};border:1px solid ${col}50;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;`;
    }

    // Summary body
    const s = d.summary;
    const trendIcon = d.stability_trend === 'improving' ? '📈' : d.stability_trend === 'worsening' ? '📉' : '➡️';
    const alertCol = { GREEN: '#34d399', YELLOW: '#fbbf24', RED: '#f87171' }[d.alert_level] || '#e2e8f0';
    bodyEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px;">
        <div class="vf-stat"><span class="vf-val green-text">${s.stable_hours}</span><span class="vf-lbl">Stable hrs</span></div>
        <div class="vf-stat"><span class="vf-val amber-text">${s.mild_hours}</span><span class="vf-lbl">Mild fluctuation</span></div>
        <div class="vf-stat"><span class="vf-val red-text">${s.severe_hours}</span><span class="vf-lbl">Severe fluctuation</span></div>
        <div class="vf-stat"><span class="vf-val" style="color:${alertCol}">${s.stable_pct}%</span><span class="vf-lbl">Stable %</span></div>
      </div>
      <div style="font-size:0.83rem;color:var(--text-dim);padding:8px 12px;background:rgba(0,0,0,0.2);border-radius:8px;">
        ${trendIcon} <strong style="color:${alertCol}">${d.alert_message}</strong>
        &nbsp;·&nbsp; Trend: <strong>${d.stability_trend}</strong>
        &nbsp;·&nbsp; Analysed ${d.hours_analyzed}h
      </div>`;

    // VSI meter
    if (meterEl && vsiBarEl && vsiLblEl) {
      meterEl.style.display = 'block';
      const vsiPct = Math.round(d.overall_vsi * 100);
      const vsiCol = vsiPct >= 75 ? '#34d399' : vsiPct >= 50 ? '#fbbf24' : '#f87171';
      vsiBarEl.style.cssText = `width:${vsiPct}%;background:linear-gradient(90deg,${vsiCol}80,${vsiCol});height:100%;border-radius:4px;transition:width 1s;`;
      vsiLblEl.textContent = `${d.overall_vsi} / 1.00`;
      vsiLblEl.style.color = vsiCol;
    }

    // Flagged events table
    if (eventsEl && evBodyEl && d.flagged_events.length > 0) {
      eventsEl.style.display = 'block';
      evBodyEl.innerHTML = d.flagged_events.map(ev => {
        const stCol = ev.status === 'SEVERE_FLUCTUATION' ? '#f87171' : '#fbbf24';
        return `<tr>
          <td style="font-size:11px;">${ev.hour}</td>
          <td><span style="color:${stCol};font-size:11px;font-weight:700;">${ev.status.replace('_', ' ')}</span></td>
          <td>${ev.min_v}V</td>
          <td>${ev.max_v}V</td>
          <td>${ev.max_v - ev.min_v}V</td>
          <td>${ev.vsi}</td>
          <td style="font-size:10px;color:var(--text-dim);">${(ev.advice || []).join('; ')}</td>
        </tr>`;
      }).join('');
    }

    // VSI history chart
    if (d.history && d.history.length) {
      if (vfHistChartInst) { vfHistChartInst.destroy(); vfHistChartInst = null; }
      const histCanvas = document.getElementById('vfHistoryChart');
      if (histCanvas) {
        const labels = d.history.map(h => h.hour.slice(-5)); // last 5 chars e.g. "22_14" → show hour
        const vsiVals = d.history.map(h => h.vsi);
        const pointColors = d.history.map(h =>
          h.status === 'STABLE' ? '#34d399' :
          h.status === 'MILD_FLUCTUATION' ? '#fbbf24' :
          h.status === 'SEVERE_FLUCTUATION' ? '#f87171' : '#64748b'
        );
        vfHistChartInst = new Chart(histCanvas.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'VSI Score',
              data: vsiVals,
              borderColor: '#38bdf8',
              backgroundColor: 'rgba(56,189,248,0.07)',
              borderWidth: 1.5,
              pointRadius: 3,
              pointBackgroundColor: pointColors,
              fill: true,
              tension: 0.3,
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { min: 0, max: 1, ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const h = d.history[ctx.dataIndex];
                    return [`VSI: ${h.vsi}`, `Status: ${h.status}`, `Spread: ${h.spread}V`];
                  }
                }
              }
            }
          }
        });
      }
    }

  } catch(e) {
    if (bodyEl) bodyEl.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// Expose new functions globally
window.onEnergyCostInput = window.onEnergyCostInput;

