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
    const [summary, hourly, anomalies] = await Promise.all([
      api("/stats/summary"),
      api(`/stats/hourly?days=${days}`),
      api(`/ml/anomalies?days=${days}`),
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
    renderAnomalyLog(anomalies);
    runMLInference(filtered);
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

// Anomaly type metadata — what each type means in plain English
const ANOMALY_META = {
  LOW_VOLTAGE: {
    label: "LOW VOLTAGE",
    color: "#f87171", // red
    icon: "📉",
    plain:
      "Power was ON but supply voltage was weak (below 210V). " +
      "This means TNEB supply quality was poor during this hour. " +
      "Not a power cut — the power was on, just at dangerously low voltage. " +
      "This can overheat motors and damage equipment.",
    what_to_do:
      "Check if this happens repeatedly — if yes, log a complaint with TNEB.",
  },
  HIGH_VOLTAGE: {
    label: "HIGH VOLTAGE",
    color: "#fbbf24", // amber
    icon: "📈",
    plain:
      "Voltage exceeded 250V. TNEB standard is 220–240V. " +
      "High voltage can burn out sensitive electronics, LEDs, and AC compressors.",
    what_to_do: "If frequent, use a voltage stabiliser. Log with TNEB.",
  },
  HIGH_POWER: {
    label: "HIGH LOAD",
    color: "#a78bfa", // purple
    icon: "⚡",
    plain:
      "An unusually large load was detected this hour (above 6000W). " +
      "This could be a geyser + AC + cooking all running simultaneously, " +
      "or possibly a fault in wiring causing abnormal current draw.",
    what_to_do:
      "Check which appliances were running. If unexpected, inspect wiring.",
  },
  POWER_OUTLIER: {
    label: "USAGE OUTLIER",
    color: "#38bdf8", // blue
    icon: "🔍",
    plain:
      "This hour's power consumption was statistically far from your normal pattern " +
      "(more than 2.5 standard deviations away — this is the Isolation Forest signal). " +
      "Not necessarily a problem — could be you ran the geyser or had guests over.",
    what_to_do:
      "Review what was running during this hour. No action needed unless it repeats.",
  },
};

function renderAnomalyLog(anomalies) {
  const el = document.getElementById("anomalyTable");
  if (!el) return;
  if (!anomalies || !anomalies.length) {
    el.innerHTML = `<div class="empty-state">
      <div style="font-size:1.4rem;margin-bottom:8px">✓</div>
      <div>No anomalies detected in this period</div>
      <div style="font-size:11px;margin-top:6px;color:var(--text-muted)">Grid voltage and load are within normal ranges</div>
    </div>`;
    return;
  }

  // Build a legend explaining what anomaly detection IS
  const legend = `<div class="anomaly-legend">
    <div class="al-title">📖 What is anomaly detection?</div>
    <div class="al-body">
      The system watches your hourly voltage and power readings. 
      Anything that falls outside your normal pattern — or crosses a hard threshold — gets flagged here.
      <strong>0V readings are power outages</strong> and are shown in the Power Outage table below, not here.
      These anomalies are cases where <strong>power was on</strong> but something unusual happened.
    </div>
  </div>`;

  const rows = anomalies
    .flatMap((a) =>
      (a.flags || []).map((f) => {
        const meta = ANOMALY_META[f.type] || {
          label: f.type,
          color: "#64748b",
          icon: "⚠",
          plain: f.meaning || "Unusual reading detected",
          what_to_do: "Monitor for recurrence.",
        };
        // Use meaning from backend if available (it's more specific), else use our meta
        const description = f.meaning || meta.plain;
        const hourStr = a.hour ? a.hour.replace("_", " ") + ":00" : "—";
        return `<div class="anomaly-card">
        <div class="anomaly-card-top">
          <div class="ac-badge" style="background:${meta.color}18;border-color:${meta.color}33;color:${meta.color}">
            ${meta.icon} ${meta.label}
          </div>
          <div class="ac-hour">Hour: ${hourStr}</div>
          <div class="ac-val" style="color:${meta.color}">${fmtNum(f.value, 1)} ${f.unit}</div>
        </div>
        <div class="ac-desc">${description}</div>
        <div class="ac-action">→ ${meta.what_to_do}</div>
      </div>`;
      }),
    )
    .join("");

  el.innerHTML = legend + rows;
}

// ============================================================
//  ML INFERENCE — from persistent Firebase hourly data
//
//  Plain English explanation of what each "model" does:
//
//  MODEL 1 — Isolation Forest (anomaly detection)
//    Imagine your hourly power readings on a number line.
//    Normal hours cluster together (200–800W).
//    The Forest builds random dividing lines across the data.
//    Outlier hours (the spike at 3000W at 2am) are far from the cluster —
//    a single dividing line isolates them. Normal hours need many lines.
//    Fewer lines needed = more anomalous. We approximate this with Z-score.
//    Z-score = how many "standard deviations" a point is from the average.
//    A Z-score of 2.5 means "this reading is 2.5x the typical spread away
//    from your average" — that's unusual enough to flag.
//
//  MODEL 2 — KMeans (load classification)
//    Groups your hours into 4 buckets by average power.
//    No labels needed — it finds the natural groupings itself.
//    Your typical midnight is always <100W (Standby).
//    AC on hours cluster around 1500W (Medium).
//    Cooking hours cluster around 2500W+ (Heavy).
//    KMeans puts imaginary center-points, assigns each hour to the nearest,
//    then moves the centers to the middle of their groups, repeats until stable.
//
//  MODEL 3 — Random Forest (bill risk forecast)
//    Takes your average hourly kWh and extrapolates to 30 days.
//    Compares that projection to the 300 kWh Slab-3 threshold.
//    In a real trained RF: 200 decision trees each vote yes/no on "will you
//    exceed 300 kWh?" and the majority wins. Here we use the math directly
//    since we're doing it in the browser without trained .pkl files.
//
//  WHEN DOES REAL TRAINING HAPPEN?
//    Run: python ml_pipeline.py --mode train
//    After 30+ days of Firebase data. Until then, these client-side
//    approximations give you the same signal.
// ============================================================
function runMLInference(data) {
  // ── Critical fix: EXCLUDE power outage hours (avg_voltage ~0)
  // A 0V hour is not an anomaly in the ML sense — it's an outage.
  // Including it would corrupt Z-scores and load classification.
  const active = data
    ? data.filter((d) => d.avg_voltage > 50 && d.avg_power >= 0)
    : [];

  if (active.length < 6) {
    const msg =
      active.length === 0
        ? "No data yet — connect ESP32"
        : `Only ${active.length} hrs — need 6+`;
    setText("mlAnomalyPct", "—");
    setText("mlReadings", msg);
    setText("mlFlagged", "—");
    setText("mlVerdict", "Collecting data...");
    setText("mlCurrentLoad", "—");
    setText("mlBillRisk", "—");
    setText("mlProjUnits", "—");
    setText("mlProjBill", "—");
    setText("mlAction", "Run ESP32 for a few hours first");
    return;
  }

  const powers = active.map((d) => d.avg_power);
  const voltages = active.map((d) => d.avg_voltage);

  // ══ MODEL 1: Isolation Forest proxy
  // Z-score = (value - average) / standard_deviation
  // Think of standard_deviation as "how spread out your values are"
  // If your avg power is 500W with std of 200W:
  //   A 1400W hour has Z = (1400-500)/200 = 4.5 → very unusual → flagged
  //   A 700W hour has  Z = (700-500)/200  = 1.0 → normal
  const pmean = mean(powers);
  const pstd = std(powers) || 1;
  const vmean = mean(voltages);
  const vstd = std(voltages) || 1;

  const flagged = active.filter((d) => {
    // Skip outage hours — 0V is not a voltage anomaly
    if (d.avg_voltage <= 50) return false;
    const pz = Math.abs((d.avg_power - pmean) / pstd);
    const vz = Math.abs((d.avg_voltage - vmean) / vstd);
    // Also flag rule-based: voltage outside safe band (even if statistically "normal")
    const lowV = d.min_voltage > 0 && d.min_voltage < 210;
    const highV = d.max_voltage > 250;
    return pz > 2.5 || vz > 2.5 || lowV || highV;
  });

  const rate = ((flagged.length / active.length) * 100).toFixed(1);
  const verdict =
    +rate < 3
      ? "✓ Normal grid"
      : +rate < 10
        ? "⚠ Some anomalies"
        : "🚨 Investigate";
  const verdictColor =
    +rate < 3 ? "green-text" : +rate < 10 ? "amber-text" : "red-text";

  setTextColor(
    "mlAnomalyPct",
    rate + "%",
    +rate < 3 ? "green-text" : +rate < 10 ? "amber-text" : "red-text",
  );
  setText("mlReadings", active.length + " active hrs");
  setTextColor(
    "mlFlagged",
    String(flagged.length),
    flagged.length === 0 ? "green-text" : "red-text",
  );
  setTextColor("mlVerdict", verdict, verdictColor);

  // ══ MODEL 2: KMeans proxy
  // Each hourly reading is assigned to the nearest cluster center by avg_power
  // Cluster centers (learned from typical household data):
  //   Standby:  0–100W   (all appliances off, just background draw)
  //   Light:    100–500W (fans, lights, router, TV)
  //   Medium:   500–2000W (AC, refrigerator, washing machine)
  //   Heavy:    2000W+   (geyser, induction cooktop, AC+geyser together)
  const latestHour = active[active.length - 1];
  const latestP = latestHour?.avg_power || 0;
  const load =
    latestP < 100
      ? "Standby"
      : latestP < 500
        ? "Light"
        : latestP < 2000
          ? "Medium"
          : "Heavy";
  const loadColor = {
    Standby: "green-text",
    Light: "blue-text",
    Medium: "amber-text",
    Heavy: "red-text",
  }[load];

  const standbyHrs = active.filter((d) => d.avg_power < 100).length;
  const lightHrs = active.filter(
    (d) => d.avg_power >= 100 && d.avg_power < 500,
  ).length;
  const medHrs = active.filter(
    (d) => d.avg_power >= 500 && d.avg_power < 2000,
  ).length;
  const heavyHrs = active.filter((d) => d.avg_power >= 2000).length;

  setTextColor("mlCurrentLoad", load, "ml-score-val " + loadColor);
  setText("mlStandby", standbyHrs + " hrs (<100W)");
  setText("mlMedium", `${lightHrs} light / ${medHrs} med hrs`);
  setText("mlHeavy", heavyHrs + " hrs (2000W+)");

  // ══ MODEL 3: Random Forest proxy
  // avgKwhPerHour = your average energy consumption each hour
  // proj30d = if you keep using at this rate for 30 days, how many kWh total?
  // Example: avg 0.3 kWh/hr × 24 hrs × 30 days = 216 kWh/month → Slab 2
  const nonZeroE = active.filter((d) => d.energy_kwh > 0);
  const avgKwhPerHour =
    nonZeroE.length > 0
      ? mean(nonZeroE.map((d) => d.energy_kwh))
      : pmean / 1000;
  const proj30d = avgKwhPerHour * 24 * 30;
  const risk = proj30d < 100 ? "LOW" : proj30d < 300 ? "MEDIUM" : "HIGH";
  const riskColor = {
    LOW: "green-text",
    MEDIUM: "amber-text",
    HIGH: "red-text",
  }[risk];
  const projBill = calcBillFull(proj30d);
  const projSlab =
    proj30d <= 100
      ? "Slab 1 (Free!)"
      : proj30d <= 200
        ? "Slab 2 (₹2.25)"
        : proj30d <= 500
          ? "Slab 3 (₹4.50)"
          : "Slab 4 (₹6.60)";
  const action =
    risk === "LOW"
      ? "✓ Very efficient usage"
      : risk === "MEDIUM"
        ? "⚠ Reduce AC/geyser hours to stay in Slab 2"
        : "🚨 Likely Slab 3/4 — target: run AC fewer hours";

  setTextColor("mlBillRisk", risk, "ml-score-val " + riskColor);
  setText("mlProjUnits", `${fmtNum(proj30d, 1)} kWh → ${projSlab}`);
  setText("mlProjBill", `₹${fmtNum(projBill.total, 0)}`);
  setTextColor("mlAction", action, riskColor);
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
  if (units <= 0)
    return { energy: 0, fixed: 45, duty: 0, total: 45, slab: "Slab 1 — Free" };
  let energy = 0;
  if (units > 100) energy += Math.min(units - 100, 100) * 2.25;
  if (units > 200) energy += Math.min(units - 200, 300) * 4.5;
  if (units > 500) energy += (units - 500) * 6.6;
  const fixed =
    units <= 100 ? 45 : units <= 200 ? 75 : units <= 500 ? 115 : 155;
  const duty = energy * 0.15;
  const total = energy + fixed + duty;
  const slab =
    units <= 100
      ? "Slab 1 — Free"
      : units <= 200
        ? "Slab 2 — ₹2.25"
        : units <= 500
          ? "Slab 3 — ₹4.50"
          : "Slab 4 — ₹6.60";
  return {
    energy: Math.round(energy * 100) / 100,
    fixed,
    duty: Math.round(duty * 100) / 100,
    total: Math.round(total * 100) / 100,
    slab,
  };
}

function updateChargesSlabPointer(units) {
  const pct =
    units <= 100
      ? (units / 100) * 20
      : units <= 200
        ? 20 + ((units - 100) / 100) * 20
        : units <= 500
          ? 40 + ((units - 200) / 300) * 30
          : Math.min(100, 70 + ((units - 500) / 300) * 30);
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
  const pct =
    units <= 100
      ? (units / 100) * 25
      : units <= 200
        ? 25 + ((units - 100) / 100) * 25
        : units <= 500
          ? 50 + ((units - 200) / 300) * 25
          : Math.min(100, 75 + ((units - 500) / 300) * 25);
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
//  XGBoost Prediction Tab Logic
// ============================================================
let isPredicting = false;

window.fetchPrediction = async () => {
    if (isPredicting) return;
    
    const uiPower = document.getElementById("predPower");
    const uiTrend = document.getElementById("predTrend");
    const uiCurrent = document.getElementById("predCurrentPower");
    const uiTime = document.getElementById("predTime");
    
    if (!uiPower) return;
    
    isPredicting = true;
    uiPower.innerHTML = '<div class="loader" style="width:24px;height:24px;border-width:2px;display:inline-block"></div>';
    uiTrend.innerText = "Analyzing recent lag features via XGBoost...";
    uiTrend.style.color = "var(--text-dim)";
    
    try {
        const res = await api('/ml/predict');
        
        if (res.error) {
            uiPower.innerHTML = "Err";
            uiCurrent.innerHTML = "�";
            uiTrend.innerHTML = '?? <span style="color:var(--red)">' + res.error + '</span>';
            if (res.error.includes("25 hours")) {
                uiTrend.innerHTML += '<br><span style="font-size:11px;color:var(--amber)">Leave the ESP32 online to collect enough data.</span>';
            }
        } else {
            uiPower.innerText = res.predicted_power_w;
            uiCurrent.innerText = res.current_power_w + " W";
            uiTime.innerText = res.prediction_time;
            
            if (res.trend === "increasing") {
                uiTrend.innerHTML = '?? Expected to rise by <strong>+' + res.difference + ' W</strong> compared to current load.';
                uiTrend.style.color = "var(--amber)";
            } else {
                uiTrend.innerHTML = '?? Expected to drop by <strong>' + res.difference + ' W</strong> compared to current load.';
                uiTrend.style.color = "var(--green)";
            }
        }
    } catch (e) {
        uiPower.innerHTML = "�";
        uiTrend.innerHTML = '<span style="color:var(--red)">Connection Error: ' + e.message + '</span>';
    } finally {
        isPredicting = false;
    }
};

// ============================================================
//  PREDICTION PAGE — All 6 ML Models
// ============================================================

let loadDoughnutChartInst = null;
let forecastChartInst = null;

// Orchestrator — called by showPage('prediction')
window.fetchPrediction = () => loadPredictionPage();

window.loadPredictionPage = async () => {
  await Promise.allSettled([
    fetchMonthlyPrediction(),
    fetchBillRisk(),
    fetchLoadType(),
    fetchForecast(),
    fetchIFAnomalies(),
  ]);
};

// ── 1. XGBoost Monthly Forecast
async function fetchMonthlyPrediction() {
  const el = document.getElementById('predMonthlyBody');
  el.innerHTML = '<div class="skeleton-item"></div>';
  try {
    const d = await api('/ml/predict');
    if (d.error) { el.innerHTML = `<div class="empty-state" style="color:var(--red)">${d.error}</div>`; return; }
    const b = d.estimated_bill || {};
    const pct = Math.min(100, Math.round((d.energy_so_far_kwh / (d.predicted_monthly_kwh || 1)) * 100));
    el.innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:8px;margin-bottom:6px;">
        <span style="font-size:2.4rem;font-weight:900;color:var(--amber);font-family:'Rajdhani',sans-serif;">${d.predicted_monthly_kwh}</span>
        <span style="color:var(--text-dim);font-size:0.9rem;margin-bottom:8px;">kWh predicted this month</span>
      </div>
      <div style="background:rgba(255,255,255,0.05);border-radius:6px;height:6px;overflow:hidden;margin-bottom:12px;">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#fbbf24,#d97706);border-radius:6px;transition:width 0.8s;"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem;">
        <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;">
          <div style="color:var(--text-dim)">Consumed so far</div>
          <div style="font-weight:700;color:var(--text)">${d.energy_so_far_kwh} kWh</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;">
          <div style="color:var(--text-dim)">Days remaining</div>
          <div style="font-weight:700;color:var(--text)">${d.days_remaining} days</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;">
          <div style="color:var(--text-dim)">Estimated bill</div>
          <div style="font-weight:700;color:var(--amber)">₹${b.total}</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;">
          <div style="color:var(--text-dim)">Slab</div>
          <div style="font-weight:700;color:var(--text);font-size:0.75rem;">${d.slab}</div>
        </div>
      </div>`;
  } catch(e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// ── 2. Random Forest Bill Risk
async function fetchBillRisk() {
  const el = document.getElementById('predBillRiskBody');
  el.innerHTML = '<div class="skeleton-item"></div>';
  try {
    const d = await api('/ml/bill-risk');
    if (d.error) { el.innerHTML = `<div class="empty-state" style="color:var(--red)">${d.error}</div>`; return; }
    const pct = d.high_bill_probability;
    const color = pct < 30 ? '#34d399' : pct < 70 ? '#fbbf24' : '#f87171';
    const riskColors = { Low: '#34d399', Medium: '#fbbf24', High: '#f87171' };
    const rc = riskColors[d.risk_label] || '#fbbf24';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:20px;padding:8px 0 12px;">
        <div style="position:relative;width:90px;height:90px;flex-shrink:0;">
          <svg viewBox="0 0 90 90" style="transform:rotate(-90deg)">
            <circle cx="45" cy="45" r="38" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="10"/>
            <circle cx="45" cy="45" r="38" fill="none" stroke="${color}" stroke-width="10"
              stroke-dasharray="${2*Math.PI*38}" stroke-dashoffset="${2*Math.PI*38*(1-pct/100)}"
              stroke-linecap="round" style="transition:stroke-dashoffset 1s;"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;">
            <span style="font-size:1.3rem;font-weight:900;color:${color};font-family:'Rajdhani';">${pct}%</span>
          </div>
        </div>
        <div>
          <div style="font-size:1.6rem;font-weight:900;color:${rc};font-family:'Rajdhani';">${d.risk_label} Risk</div>
          <div style="font-size:0.8rem;color:var(--text-dim);margin-top:4px;">Probability of exceeding 300 kWh this billing period</div>
          <div style="font-size:0.78rem;color:var(--text-dim);margin-top:6px;">Analysed ${d.hours_analyzed} hours · Latest hr: ${d.latest_hour_probability}%</div>
        </div>
      </div>`;
  } catch(e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// ── 3. KMeans Load Classification
async function fetchLoadType() {
  const el = document.getElementById('predLoadBody');
  el.innerHTML = '<div class="skeleton-item"></div>';
  try {
    const d = await api('/ml/load');
    if (d.error) { el.innerHTML = `<div class="empty-state" style="color:var(--red)">${d.error}</div>`; return; }
    const lc = {Standby:'#38bdf8','Light Load':'#34d399','Medium Load':'#fbbf24','Heavy Load':'#f87171'};
    const typeColor = lc[d.current_load_type] || '#e2e8f0';
    el.innerHTML = `
      <div style="text-align:center;padding:4px 0 8px;">
        <div style="font-size:1.8rem;font-weight:900;color:${typeColor};font-family:'Rajdhani';">${d.current_load_type}</div>
        <div style="font-size:0.75rem;color:var(--text-dim);">Current load category</div>
      </div>`;
    const dist = d.distribution;
    const total = Object.values(dist).reduce((a,b)=>a+b,0) || 1;
    const colors = ['#38bdf8','#34d399','#fbbf24','#f87171'];
    const labels = Object.keys(dist);
    const vals   = Object.values(dist);

    if (loadDoughnutChartInst) { loadDoughnutChartInst.destroy(); loadDoughnutChartInst = null; }
    const ctx = document.getElementById('loadDoughnutChart').getContext('2d');
    loadDoughnutChartInst = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets:[{ data:vals, backgroundColor:colors, borderWidth:0, hoverOffset:4 }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        cutout:'65%',
        plugins: {
          legend:{ position:'right', labels:{ color:'#94a3b8', font:{ size:11 }, boxWidth:10, padding:8 } }
        }
      }
    });
  } catch(e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// ── 4. PyTorch 24-Hour Forecast
async function fetchForecast() {
  const meta = document.getElementById('predForecastMeta');
  meta.textContent = 'Loading…';
  try {
    const d = await api('/ml/forecast');
    if (d.error) { meta.innerHTML = `<span style="color:var(--red)">${d.error}</span>`; return; }
    meta.textContent = `From ${d.from_hour}  ·  ${d.model}`;
    if (forecastChartInst) { forecastChartInst.destroy(); forecastChartInst = null; }
    const ctx = document.getElementById('forecastChart').getContext('2d');
    forecastChartInst = new Chart(ctx, {
      type: 'line',
      data: {
        labels: d.hours,
        datasets: [{
          label:'Predicted Power (W)',
          data: d.forecast_w,
          borderColor:'#34d399',
          backgroundColor:'rgba(52,211,153,0.08)',
          borderWidth:2,
          pointRadius:3,
          pointBackgroundColor:'#34d399',
          fill:true,
          tension:0.35
        }]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        scales: {
          x:{ ticks:{ color:'#64748b', font:{size:10} }, grid:{ color:'rgba(255,255,255,0.05)' } },
          y:{ ticks:{ color:'#64748b' }, grid:{ color:'rgba(255,255,255,0.05)' }, beginAtZero:true }
        },
        plugins:{ legend:{ display:false } }
      }
    });
  } catch(e) {
    meta.innerHTML = `<span style="color:var(--red)">Error: ${e.message}</span>`;
  }
}

// ── 5. Isolation Forest Anomalies
async function fetchIFAnomalies() {
  const el = document.getElementById('predIFBody');
  el.innerHTML = '<div class="skeleton-item"></div>';
  try {
    const d = await api('/ml/anomalies/isolation-forest?days=1');
    if (d.error) { el.innerHTML = `<div class="empty-state" style="color:var(--red)">${d.error}</div>`; return; }
    if (d.anomaly_count === 0) {
      el.innerHTML = `<div class="empty-state" style="color:var(--green);padding:1.2rem;">✓ No power anomalies detected by Isolation Forest in the last 24 hours.</div>`;
      return;
    }
    const pct = d.anomaly_pct;
    let rows = d.flagged.slice(0,10).map(f =>
      `<tr>
        <td>${f.hour}</td>
        <td>${f.avg_power} W</td>
        <td style="font-size:11px;color:${f.score < -0.05 ? '#f87171' : '#fbbf24'}">${f.score.toFixed(4)}</td>
       </tr>`
    ).join('');
    el.innerHTML = `
      <div style="display:flex;gap:24px;align-items:center;padding:12px 0 14px;">
        <div style="text-align:center;">
          <div style="font-size:2rem;font-weight:900;color:#f87171;font-family:'Rajdhani';">${d.anomaly_count}</div>
          <div style="font-size:11px;color:var(--text-dim);">anomalous hours</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:2rem;font-weight:900;color:#fbbf24;font-family:'Rajdhani';">${pct}%</div>
          <div style="font-size:11px;color:var(--text-dim);">of all hours</div>
        </div>
        <div style="font-size:0.78rem;color:var(--text-dim);flex:1;">
          Isolation Forest flagged these hours as statistically unusual.<br>
          Negative scores = more anomalous. Trained on 34k+ UCI records (5% contamination).
        </div>
      </div>
      <div class="tbl-wrap" style="max-height:200px;overflow-y:auto;">
        <table class="data-table">
          <thead><tr><th>Hour</th><th>Avg Power</th><th>Anomaly Score</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch(e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}
