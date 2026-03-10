// app.js — EnergyFlow Frontend (4-page SPA)
import { auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const BACKEND = "https://electric-meter-in-web.onrender.com";

// ===================== AUTH MODE =====================
let currentAuthMode = "login";

window.switchAuthTab = (mode) => {
  currentAuthMode = mode;
  document
    .getElementById("loginTabBtn")
    .classList.toggle("active", mode === "login");
  document
    .getElementById("signupTabBtn")
    .classList.toggle("active", mode === "signup");
  const btn = document.getElementById("authSubmitBtn");
  btn.textContent = mode === "login" ? "Login" : "Create Account";
  btn.onclick = mode === "login" ? login : signup;
  document.getElementById("authError").textContent = "";
};

window.signup = async () => {
  const e = document.getElementById("email").value;
  const p = document.getElementById("password").value;
  try {
    await createUserWithEmailAndPassword(auth, e, p);
  } catch (err) {
    document.getElementById("authError").textContent = err.message;
  }
};

window.login = async () => {
  const e = document.getElementById("email").value;
  const p = document.getElementById("password").value;
  try {
    await signInWithEmailAndPassword(auth, e, p);
  } catch (err) {
    document.getElementById("authError").textContent = err.message;
  }
};

window.logout = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  if (user) {
    document.getElementById("authDiv").style.display = "none";
    document.getElementById("appDiv").style.display = "block";
    document.getElementById("navTabs").style.display = "flex";
    document.getElementById("regDevBtn").style.display = "block";
    document.getElementById("logoutBtn").style.display = "block";
    document.getElementById("userBadge").style.display = "flex";
    document.getElementById("userEmail").textContent = user.email.split("@")[0];
    initApp();
  } else {
    document.getElementById("authDiv").style.display = "flex";
    document.getElementById("appDiv").style.display = "none";
    document.getElementById("navTabs").style.display = "none";
    document.getElementById("regDevBtn").style.display = "none";
    document.getElementById("logoutBtn").style.display = "none";
    document.getElementById("userBadge").style.display = "none";
  }
});

// ===================== PAGE NAVIGATION =====================
let currentPage = "dashboard";

window.showPage = (page) => {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.page === page);
  });
  document.getElementById(`page-${page}`).classList.add("active");
  currentPage = page;
  if (page === "statistics") buildStatCharts();
  if (page === "charges") updateChargesPage();
};

// ===================== INIT =====================
function initApp() {
  initCharts();
  loadDevices();
  loadBillingHistory();
  startLivePoll();
  setInterval(loadDevices, 10000);
  setInterval(updateDashTime, 1000);
  renderCalendar();
}

function updateDashTime() {
  const el = document.getElementById("dashTime");
  if (el) el.textContent = new Date().toLocaleTimeString();
}

// ===================== TOAST =====================
window.showToast = (msg) => {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
};

// ===================== BILL CALCULATION =====================
function calculateBill(units) {
  if (units <= 0) return 0;
  if (units <= 100) return 0;
  let cost = 0;
  if (units > 100) cost += Math.min(units - 100, 100) * 2.25;
  if (units > 200) cost += Math.min(units - 200, 300) * 4.5;
  if (units > 500) cost += (units - 500) * 6.6;
  return Math.round(cost * 100) / 100;
}

function getFixedCharge(units) {
  if (units <= 100) return 45;
  if (units <= 200) return 75;
  if (units <= 500) return 115;
  return 155;
}

function getSlabLabel(units) {
  if (units <= 100) return "Slab 1 (Free)";
  if (units <= 200) return "Slab 2 (₹2.25/unit)";
  if (units <= 500) return "Slab 3 (₹4.50/unit)";
  return "Slab 4 (₹6.60/unit)";
}

// ===================== DEVICES =====================
async function loadDevices() {
  if (!auth.currentUser) return;
  const token = await auth.currentUser.getIdToken();
  try {
    const res = await fetch(`${BACKEND}/devices`, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return;
    const devices = await res.json();
    const list = document.getElementById("deviceList");
    const now = Math.floor(Date.now() / 1000);

    if (!devices.length) {
      list.innerHTML = `<p style="opacity:0.5;font-size:12px;padding:10px">No devices registered. Click "+ Device" to add one.</p>`;
      return;
    }

    list.innerHTML = devices
      .map((d) => {
        const active = d.last_seen && now - d.last_seen < 30;
        return `<div class="device-item">
        <div>
          <div class="device-id">${d.device_id}</div>
          <div class="device-time">${d.last_seen ? "Last seen: " + new Date(d.last_seen * 1000).toLocaleTimeString() : "Never"}</div>
        </div>
        <div class="device-status ${active ? "status-active" : "status-inactive"}">${active ? "● ACTIVE" : "○ OFFLINE"}</div>
      </div>`;
      })
      .join("");
  } catch {}
}

// ===================== LIVE DATA =====================
let liveHistory = { labels: [], voltage: [], current: [], power: [] };
const MAX_POINTS = 60;
let prevPower = 0,
  prevVoltage = 0;

async function fetchLive() {
  if (!auth.currentUser) return;
  const token = await auth.currentUser.getIdToken();
  try {
    const res = await fetch(`${BACKEND}/live`, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return;
    const d = await res.json();

    if (d.error) return;

    const voltage = d.voltage || 0;
    const power = d.power || 0;
    const current = d.current || (voltage > 0 ? power / voltage : 0);
    const energy = d.energy_kWh || 0;
    const unitsUsed = d.units_used || 0;
    const bill = calculateBill(unitsUsed);
    const ts = new Date().toLocaleTimeString("en-IN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    // --- DASHBOARD KPIs ---
    document.getElementById("kpiPower").textContent = power.toFixed(1);
    document.getElementById("kpiVoltage").textContent = voltage.toFixed(1);
    document.getElementById("kpiKwh").textContent = energy.toFixed(3);
    document.getElementById("kpiBill").textContent = bill.toFixed(2);
    document.getElementById("dashUsedUnits").textContent =
      unitsUsed.toFixed(3) + " kWh";
    document.getElementById("dashAmount").textContent = "₹" + bill.toFixed(2);
    document.getElementById("dashTotalUnits").textContent =
      energy.toFixed(3) + " kWh";

    // Slab indicator
    const slabPct = Math.min((unitsUsed / 600) * 100, 98);
    const si = document.getElementById("slabIndicator");
    if (si) si.style.left = slabPct + "%";

    // Dashboard chart
    if (dashPowerChart) {
      liveHistory.labels.push(ts);
      liveHistory.voltage.push(voltage);
      liveHistory.power.push(power);
      if (liveHistory.labels.length > 20) {
        liveHistory.labels.shift();
        liveHistory.voltage.shift();
        liveHistory.power.shift();
      }
      dashPowerChart.data.labels = liveHistory.labels;
      dashPowerChart.data.datasets[0].data = liveHistory.power;
      dashPowerChart.data.datasets[1].data = liveHistory.voltage;
      dashPowerChart.update("none");
    }

    // --- LIVE PAGE ---
    document.getElementById("liveVoltage").textContent = voltage.toFixed(1);
    document.getElementById("liveCurrent").textContent = current.toFixed(3);
    document.getElementById("livePower").textContent = power.toFixed(1);
    document.getElementById("liveEnergy").textContent = energy.toFixed(4);
    document.getElementById("liveEnergyCost").textContent = bill.toFixed(2);

    // Status pills
    updateStatusPill("voltageStatus", voltage, 220, 240, "V");
    updateStatusPill("currentStatus", current, 0, 25, "A");
    updateStatusPill("powerStatus", power, 0, 5000, "W");

    // Live charts
    liveChartAdd(voltage, current, power, ts);

    // Draw gauges
    drawGauge("voltageGauge", voltage, 180, 260, "#38bdf8");
    drawGauge("currentGauge", current, 0, 32, "#fbbf24");
    drawGauge("powerGauge", power, 0, 7360, "#a78bfa");

    // Live status
    document.getElementById("liveStatus").innerHTML =
      `<span class="pulse-dot"></span> Live · ${ts}`;

    // Log
    const anomaly = voltage < 210 || voltage > 250 || current > 28;
    addLogLine(
      `[${ts}] V:${voltage.toFixed(1)} A:${current.toFixed(3)} W:${power.toFixed(1)} kWh:${energy.toFixed(4)}`,
      anomaly ? "warn" : "",
    );

    // Store for stats
    storeToLocalStats({
      voltage,
      current,
      power,
      energy,
      ts,
      timestamp: Date.now(),
    });

    // Update charges page if active
    if (currentPage === "charges") updateChargesLive(unitsUsed);

    prevPower = power;
    prevVoltage = voltage;
  } catch (e) {
    document.getElementById("liveStatus").innerHTML =
      `<span style="color:var(--red-dim)">● Disconnected</span>`;
  }
}

function updateStatusPill(id, val, low, high, unit) {
  const el = document.getElementById(id);
  if (!el) return;
  if (val < low * 0.9 || val > high * 1.1) {
    el.textContent = "⚠ ALERT";
    el.className = "status-pill alert";
  } else if (val < low || val > high * 0.95) {
    el.textContent = "CAUTION";
    el.className = "status-pill warn";
  } else {
    el.textContent = "NOMINAL";
    el.className = "status-pill";
  }
}

// ===================== GAUGE CANVAS =====================
function drawGauge(canvasId, value, min, max, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width,
    H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2,
    cy = H * 0.85;
  const r = Math.min(W, H * 1.5) * 0.42;
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const valAngle = startAngle + pct * Math.PI;

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.stroke();

  // Value arc
  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, "rgba(255,255,255,0.2)");
  grad.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, valAngle);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.stroke();

  // Glow
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(cx, cy, r, valAngle - 0.05, valAngle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Tick marks
  for (let i = 0; i <= 10; i++) {
    const a = startAngle + (i / 10) * Math.PI;
    const x1 = cx + (r - 14) * Math.cos(a),
      y1 = cy + (r - 14) * Math.sin(a);
    const x2 = cx + (r - 8) * Math.cos(a),
      y2 = cy + (r - 8) * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ===================== LIVE CHARTS =====================
let liveVoltageChart, liveCurrentChart, livePowerChart;
const liveData = { labels: [], voltage: [], current: [], power: [] };

function initLiveCharts() {
  const opts = (label, data, color, bgColor) => ({
    type: "line",
    data: {
      labels: liveData.labels,
      datasets: [
        {
          label,
          data,
          borderColor: color,
          backgroundColor: bgColor,
          borderWidth: 1.5,
          tension: 0.4,
          fill: true,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: false },
        y: {
          grid: { color: "rgba(255,255,255,0.04)" },
          ticks: { color: "#64748b", font: { size: 10 }, maxTicksLimit: 5 },
        },
      },
      plugins: { legend: { display: false } },
    },
  });

  liveVoltageChart = new Chart(
    document.getElementById("liveVoltageChart"),
    opts("V", liveData.voltage, "#38bdf8", "rgba(56,189,248,0.08)"),
  );
  liveCurrentChart = new Chart(
    document.getElementById("liveCurrentChart"),
    opts("A", liveData.current, "#fbbf24", "rgba(251,191,36,0.08)"),
  );
  livePowerChart = new Chart(
    document.getElementById("livePowerChart"),
    opts("W", liveData.power, "#a78bfa", "rgba(167,139,250,0.08)"),
  );
}

function liveChartAdd(v, a, w, ts) {
  liveData.labels.push(ts);
  liveData.voltage.push(v);
  liveData.current.push(a);
  liveData.power.push(w);
  if (liveData.labels.length > MAX_POINTS) {
    liveData.labels.shift();
    liveData.voltage.shift();
    liveData.current.shift();
    liveData.power.shift();
  }
  if (liveVoltageChart) {
    liveVoltageChart.update("none");
    liveCurrentChart.update("none");
    livePowerChart.update("none");
  }
}

window.clearLog = () => {
  document.getElementById("rawLog").innerHTML = "";
};

function addLogLine(text, cls = "") {
  const log = document.getElementById("rawLog");
  const span = document.createElement("span");
  span.className = "log-line " + cls;
  span.textContent = text;
  log.prepend(span);
  if (log.children.length > 100) log.lastChild.remove();
}

// ===================== DASHBOARD CHART =====================
let dashPowerChart;

function initDashChart() {
  const ctx = document.getElementById("dashPowerChart").getContext("2d");
  dashPowerChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Power (W)",
          data: [],
          borderColor: "#fbbf24",
          backgroundColor: "rgba(251,191,36,0.08)",
          borderWidth: 2,
          tension: 0.4,
          fill: true,
          pointRadius: 0,
          yAxisID: "yW",
        },
        {
          label: "Voltage (V)",
          data: [],
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56,189,248,0.04)",
          borderWidth: 1.5,
          tension: 0.4,
          fill: false,
          pointRadius: 0,
          yAxisID: "yV",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: false },
        yW: {
          position: "left",
          grid: { color: "rgba(255,255,255,0.04)" },
          ticks: { color: "#64748b", font: { size: 10 } },
        },
        yV: {
          position: "right",
          grid: { display: false },
          ticks: { color: "#64748b", font: { size: 10 } },
        },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ===================== STATISTICS =====================
let hourlyEChart, hourlyPChart, voltageStabChart;
let statView = "today";
let localStats = [];

function storeToLocalStats(entry) {
  localStats.push(entry);
  if (localStats.length > 3600) localStats.shift(); // ~3 hours at 3s
}

window.setStatView = (view) => {
  statView = view;
  ["today", "yesterday", "week"].forEach((v) => {
    const btn = document.getElementById(
      "btn" + v.charAt(0).toUpperCase() + v.slice(1),
    );
    if (btn) btn.classList.toggle("active-btn", v === view);
  });
  if (currentPage === "statistics") buildStatCharts();
};

function buildStatCharts() {
  const now = Date.now();
  let data = localStats;

  if (statView === "today") {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    data = localStats.filter((d) => d.timestamp >= midnight.getTime());
  } else if (statView === "yesterday") {
    const yStart = new Date();
    yStart.setDate(yStart.getDate() - 1);
    yStart.setHours(0, 0, 0, 0);
    const yEnd = new Date();
    yEnd.setHours(0, 0, 0, 0);
    data = localStats.filter(
      (d) => d.timestamp >= yStart.getTime() && d.timestamp < yEnd.getTime(),
    );
  }

  // Bucket into hourly
  const hours = {};
  data.forEach((d) => {
    const h = new Date(d.timestamp).getHours();
    if (!hours[h])
      hours[h] = {
        powers: [],
        voltages: [],
        count: 0,
        energyStart: d.energy,
        energyEnd: d.energy,
      };
    hours[h].powers.push(d.power);
    hours[h].voltages.push(d.voltage);
    hours[h].energyEnd = d.energy;
    hours[h].count++;
  });

  const labels = [],
    energyData = [],
    powerData = [],
    voltageData = [];
  let peakPow = 0,
    sumPow = 0,
    minV = 999,
    maxV = 0,
    totalReadings = 0;

  for (let h = 0; h < 24; h++) {
    labels.push(h + ":00");
    if (hours[h]) {
      const avgP =
        hours[h].powers.reduce((a, b) => a + b, 0) / hours[h].powers.length;
      const avgV =
        hours[h].voltages.reduce((a, b) => a + b, 0) / hours[h].voltages.length;
      const consumption = Math.max(
        0,
        hours[h].energyEnd - hours[h].energyStart,
      );
      energyData.push(+consumption.toFixed(4));
      powerData.push(+avgP.toFixed(1));
      voltageData.push(+avgV.toFixed(1));
      if (avgP > peakPow) peakPow = avgP;
      sumPow += avgP;
      totalReadings++;
      if (avgV < minV) minV = avgV;
      if (avgV > maxV) maxV = avgV;
    } else {
      energyData.push(null);
      powerData.push(null);
      voltageData.push(null);
    }
  }

  // Update KPIs
  document.getElementById("statPeak").textContent =
    peakPow > 0 ? peakPow.toFixed(0) + "W" : "—";
  document.getElementById("statAvg").textContent =
    totalReadings > 0 ? (sumPow / totalReadings).toFixed(0) + "W" : "—";
  document.getElementById("statMinV").textContent =
    minV < 999 ? minV.toFixed(1) + "V" : "—";
  document.getElementById("statMaxV").textContent =
    maxV > 0 ? maxV.toFixed(1) + "V" : "—";

  // Detect anomalies
  const anomalies = data.filter(
    (d) =>
      d.voltage < 210 || d.voltage > 250 || d.current > 28 || d.power > 6000,
  );
  document.getElementById("statAnomalies").textContent = anomalies.length;
  renderAnomalyTable(anomalies);

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: {
        ticks: { color: "#64748b", font: { size: 9 }, maxRotation: 45 },
        grid: { color: "rgba(255,255,255,0.04)" },
      },
      y: {
        ticks: { color: "#64748b", font: { size: 10 } },
        grid: { color: "rgba(255,255,255,0.04)" },
      },
    },
    plugins: { legend: { display: false } },
  };

  // Hourly energy chart
  if (hourlyEChart) hourlyEChart.destroy();
  hourlyEChart = new Chart(document.getElementById("hourlyEnergyChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "kWh",
          data: energyData,
          backgroundColor: "rgba(52,211,153,0.5)",
          borderColor: "#34d399",
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: chartDefaults,
  });

  if (hourlyPChart) hourlyPChart.destroy();
  hourlyPChart = new Chart(document.getElementById("hourlyPowerChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "W",
          data: powerData,
          borderColor: "#fbbf24",
          backgroundColor: "rgba(251,191,36,0.1)",
          borderWidth: 2,
          tension: 0.4,
          fill: true,
          pointRadius: 3,
          pointBackgroundColor: "#fbbf24",
        },
      ],
    },
    options: chartDefaults,
  });

  if (voltageStabChart) voltageStabChart.destroy();
  voltageStabChart = new Chart(
    document.getElementById("voltageStabilityChart"),
    {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Voltage",
            data: voltageData,
            borderColor: "#38bdf8",
            backgroundColor: "rgba(56,189,248,0.08)",
            borderWidth: 2,
            tension: 0.3,
            fill: true,
            pointRadius: 2,
            pointBackgroundColor: "#38bdf8",
          },
          {
            label: "220V",
            data: new Array(24).fill(220),
            borderColor: "rgba(248,113,113,0.4)",
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false,
          },
          {
            label: "240V",
            data: new Array(24).fill(240),
            borderColor: "rgba(248,113,113,0.4)",
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: { ...chartDefaults, plugins: { legend: { display: false } } },
    },
  );
}

function renderAnomalyTable(anomalies) {
  const el = document.getElementById("anomalyTable");
  if (!anomalies.length) {
    el.innerHTML = `<div class="empty-state">No anomalies detected in this period</div>`;
    return;
  }
  el.innerHTML = anomalies
    .slice(0, 20)
    .map((a) => {
      let type = "",
        desc = "",
        val = "";
      if (a.voltage < 210) {
        type = "LOW VOLTAGE";
        desc = "Voltage dropped below safe threshold (210V)";
        val = a.voltage.toFixed(1) + "V";
      } else if (a.voltage > 250) {
        type = "HIGH VOLTAGE";
        desc = "Voltage exceeded safe threshold (250V)";
        val = a.voltage.toFixed(1) + "V";
      } else if (a.current > 28) {
        type = "OVERCURRENT";
        desc = "Current exceeded 28A limit";
        val = (a.current || 0).toFixed(2) + "A";
      } else if (a.power > 6000) {
        type = "HIGH POWER";
        desc = "Power consumption spike detected";
        val = a.power.toFixed(0) + "W";
      }
      return `<div class="anomaly-row">
      <span class="anomaly-time">${a.ts}</span>
      <span class="anomaly-type">⚠ ${type}</span>
      <span class="anomaly-desc">${desc}</span>
      <span class="anomaly-val">${val}</span>
    </div>`;
    })
    .join("");
}

// ===================== BILLING =====================
let billingHistory = [];
let curM = new Date().getMonth(),
  curY = new Date().getFullYear();

window.takeReading = async () => {
  const btn = document.getElementById("takeBtn");
  btn.disabled = true;
  btn.textContent = "Processing...";
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch(`${BACKEND}/billing/take-reading`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    const data = await res.json();
    showToast(
      `Reading taken! Units: ${(data.units || 0).toFixed(3)} kWh · ₹${(data.amount || 0).toFixed(2)}`,
    );
    await loadBillingHistory();
  } catch {
    showToast("Failed to take reading");
  }
  btn.textContent = "Take Reading";
  btn.disabled = false;
};

async function loadBillingHistory() {
  if (!auth.currentUser) return;
  const token = await auth.currentUser.getIdToken();
  try {
    const res = await fetch(`${BACKEND}/billing/history`, {
      headers: { Authorization: "Bearer " + token },
    });
    const data = await res.json();
    billingHistory = data
      ? Object.values(data).sort((a, b) => (b.to_ts || 0) - (a.to_ts || 0))
      : [];
    renderCalendar();
    renderBillingTable();
  } catch {}
}

function renderBillingTable() {
  const tbody = document.getElementById("billingHistoryBody");
  if (!billingHistory.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-td">No billing records yet. Click "Take Reading" to start.</td></tr>`;
    return;
  }
  tbody.innerHTML = billingHistory
    .map((b, i) => {
      const from = b.from_ts
        ? new Date(b.from_ts * 1000).toLocaleDateString("en-IN")
        : "—";
      const to = b.to_ts
        ? new Date(b.to_ts * 1000).toLocaleDateString("en-IN")
        : "—";
      const energy = calculateBill(b.units || 0);
      const fixed = getFixedCharge(b.units || 0);
      return `<tr>
      <td style="color:var(--text-dim)">${i + 1}</td>
      <td>${from} → ${to}</td>
      <td style="font-family:'Space Mono',monospace">${(b.units || 0).toFixed(3)}</td>
      <td style="color:var(--amber);font-family:'Space Mono',monospace">₹${energy.toFixed(2)}</td>
      <td style="color:var(--text-dim)">₹${fixed.toFixed(2)}</td>
      <td style="font-weight:700;color:var(--amber);font-family:'Space Mono',monospace">₹${(energy + fixed).toFixed(2)}</td>
    </tr>`;
    })
    .join("");
}

// ===================== CALENDAR =====================
window.prevMonth = () => {
  curM--;
  if (curM < 0) {
    curM = 11;
    curY--;
  }
  renderCalendar();
};
window.nextMonth = () => {
  curM++;
  if (curM > 11) {
    curM = 0;
    curY++;
  }
  renderCalendar();
};

function renderCalendar() {
  const grid = document.getElementById("calendarGrid");
  const monthLab = document.getElementById("calendarMonth");
  if (!grid) return;
  grid.innerHTML = "";

  const firstDay = new Date(curY, curM, 1).getDay();
  const daysInMonth = new Date(curY, curM + 1, 0).getDate();
  monthLab.textContent = new Date(curY, curM).toLocaleString("default", {
    month: "long",
    year: "numeric",
  });

  for (let i = 0; i < firstDay; i++)
    grid.innerHTML += `<div class="calendar-day" style="opacity:0;border:none"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = new Date(curY, curM, d).toDateString();
    const dayBills = billingHistory.filter(
      (b) => b.to_ts && new Date(b.to_ts * 1000).toDateString() === dateStr,
    );
    const dayTotal = dayBills.reduce(
      (s, b) =>
        s + (calculateBill(b.units || 0) + getFixedCharge(b.units || 0)),
      0,
    );
    const hasReading = dayBills.length > 0;

    let style = "",
      content = "";
    if (hasReading) {
      style =
        "background:rgba(52,211,153,0.08);border-color:rgba(52,211,153,0.3)";
      content = `<span class="cal-day-amount">${dayTotal > 0 ? "₹" + dayTotal.toFixed(0) : "✓"}</span>`;
    }

    grid.innerHTML += `<div class="calendar-day" style="${style}">
      <span class="cal-day-num">${d}</span>
      ${content}
    </div>`;
  }
}

// ===================== CHARGES PAGE =====================
function updateChargesPage() {
  // Read current live data from KPIs
  const units = parseFloat(
    document.getElementById("dashUsedUnits")?.textContent || "0",
  );
  updateChargesLive(units);
  renderBillingTable();
}

function updateChargesLive(units) {
  const energyCharge = calculateBill(units);
  const fixed = getFixedCharge(units);
  const duty = energyCharge > 0 ? energyCharge * 0.15 : 0;
  const total = energyCharge + fixed + duty;

  document.getElementById("lbUnits").textContent = units.toFixed(3) + " kWh";
  document.getElementById("lbSlab").textContent = getSlabLabel(units);
  document.getElementById("lbEnergy").textContent =
    "₹" + energyCharge.toFixed(2);
  document.getElementById("lbFixed").textContent = "₹" + fixed.toFixed(2);
  document.getElementById("lbDuty").textContent = "₹" + duty.toFixed(2);
  document.getElementById("lbTotal").textContent = "₹" + total.toFixed(2);

  // Pointer position
  const pct = Math.min((units / 600) * 100, 98);
  const ptr = document.getElementById("svPointer");
  if (ptr) ptr.style.left = pct + "%";
}

// ===================== MANUAL CALCULATOR =====================
window.calculateCustomBill = () => {
  const units = parseFloat(document.getElementById("calcUnits")?.value || 0);
  const months = parseInt(document.getElementById("calcMonths")?.value || 1);
  const resultEl = document.getElementById("calcResult");

  if (!units || units < 0) {
    if (resultEl) resultEl.style.display = "none";
    return;
  }

  const energy = calculateBill(units);
  const fixed = getFixedCharge(units) * months;
  const duty = energy * 0.15;
  const total = energy + fixed + duty;

  const breakdown = document.getElementById("calcBreakdown");
  const lines = [
    ["Units consumed", units.toFixed(0) + " kWh"],
    ["Slab", getSlabLabel(units)],
    ["Energy charges", "₹" + energy.toFixed(2)],
    ["Fixed charges (×" + months + " mo)", "₹" + fixed.toFixed(2)],
    ["Electricity duty (15%)", "₹" + duty.toFixed(2)],
  ];

  breakdown.innerHTML = lines
    .map(
      ([l, v]) =>
        `<div class="calc-line"><span>${l}</span><span>${v}</span></div>`,
    )
    .join("");

  document.getElementById("calcTotal").textContent = "₹" + total.toFixed(2);
  resultEl.style.display = "block";
};

// ===================== DEVICE MODAL =====================
window.openDeviceModal = () =>
  (document.getElementById("deviceModal").style.display = "flex");
window.closeDeviceModal = () =>
  (document.getElementById("deviceModal").style.display = "none");
window.registerDevice = async () => {
  const id = document.getElementById("deviceId").value.trim();
  if (!id) {
    alert("Enter a Device ID");
    return;
  }
  const token = await auth.currentUser.getIdToken();
  await fetch(`${BACKEND}/register-device?device_id=${id}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });
  closeDeviceModal();
  loadDevices();
  showToast("Device " + id + " registered!");
};

// ===================== START =====================
function startLivePoll() {
  fetchLive();
  setInterval(fetchLive, 3000);
}

function initCharts() {
  initDashChart();
  initLiveCharts();
}
