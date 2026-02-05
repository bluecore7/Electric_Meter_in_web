import { auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const BACKEND = "https://electric-meter-in-web.onrender.com";

/* ---------- DOM ELEMENTS ---------- */
const authDiv = document.getElementById("authDiv");
const dashboardDiv = document.getElementById("dashboardDiv");
const amountEl = document.getElementById("amount");
const takeBtn = document.getElementById("takeBtn");
const logoutBtn = document.getElementById("logoutBtn");

// NEW: Elements for unit readings
const totalUnitsEl = document.getElementById("totalUnits");
const usedUnitsEl = document.getElementById("usedUnits");

/* ---------- AUTH ---------- */
window.signup = async () => {
  const e = document.getElementById("email").value;
  const p = document.getElementById("password").value;
  try {
    await createUserWithEmailAndPassword(auth, e, p);
  } catch (err) {
    alert(err.message);
  }
};

window.login = async () => {
  const e = document.getElementById("email").value;
  const p = document.getElementById("password").value;
  try {
    await signInWithEmailAndPassword(auth, e, p);
  } catch (err) {
    alert(err.message);
  }
};

window.logout = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  if (user) {
    authDiv.style.display = "none";
    dashboardDiv.style.display = "block";
    logoutBtn.style.display = "block";
    loadBillingHistory();
    loadDevices();
  } else {
    authDiv.style.display = "grid";
    dashboardDiv.style.display = "none";
    logoutBtn.style.display = "none";
  }
});

/* ---------- DEVICE STATUS ---------- */
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
    list.innerHTML = "";

    const now = Math.floor(Date.now() / 1000);

    if (devices.length === 0) {
      list.innerHTML = `<p style="opacity:0.5; font-size:12px">No devices. Register one!</p>`;
      return;
    }

    devices.forEach((d) => {
      const isActive = d.last_seen && now - d.last_seen < 30;
      list.innerHTML += `
        <div class="device-item">
          <div>
            <div style="font-weight:600; font-size: 14px; color: #e2e8f0;">${d.device_id}</div>
            <div style="font-size:11px; opacity:0.5; margin-top:2px;">
             ${d.last_seen ? "Seen: " + new Date(d.last_seen * 1000).toLocaleTimeString() : "Never"}
            </div>
          </div>
          <div class="device-status ${isActive ? "active" : "inactive"}">
            ${isActive ? "● ACTIVE" : "○ INACTIVE"}
          </div>
        </div>`;
    });
  } catch (err) {
    console.error(err);
  }
}

/* ---------- LIVE DATA & CHARTS ---------- */
let labels = [],
  voltageData = [],
  powerData = [];

const chartConfig = (label, data, color, bg) => ({
  type: "line",
  data: {
    labels: labels,
    datasets: [
      {
        label,
        data,
        borderColor: color,
        backgroundColor: bg,
        borderWidth: 2,
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
        grid: { color: "rgba(255,255,255,0.05)" },
        ticks: { color: "#94a3b8", font: { size: 10 } },
      },
    },
    plugins: { legend: { display: false } },
  },
});

const vCtx = document.getElementById("voltageChart").getContext("2d");
const pCtx = document.getElementById("powerChart").getContext("2d");
const voltageChart = new Chart(
  vCtx,
  chartConfig("Voltage", voltageData, "#38bdf8", "rgba(56, 189, 248, 0.1)"),
);
const powerChart = new Chart(
  pCtx,
  chartConfig("Power", powerData, "#6366f1", "rgba(99, 102, 241, 0.1)"),
);

// ---------------------------------------------------------
// ⚡ NEW: CLIENT-SIDE BILL CALCULATOR
// ---------------------------------------------------------
function calculateBill(units) {
  if (units <= 100) return 0;
  let cost = 0;

  // Slab 1: 101-200 units = ₹2.25/unit
  if (units > 100) cost += Math.min(units - 100, 100) * 2.25;

  // Slab 2: 201-500 units = ₹4.50/unit
  if (units > 200) cost += Math.min(units - 200, 300) * 4.5;

  // Slab 3: >500 units = ₹6.60/unit
  if (units > 500) cost += (units - 500) * 6.6;

  return cost;
}

async function fetchLive() {
  if (!auth.currentUser) return;
  const token = await auth.currentUser.getIdToken();
  try {
    const res = await fetch(`${BACKEND}/live`, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return;

    const d = await res.json();

    // 1. UPDATE CHARTS
    const timeStr = new Date().toLocaleTimeString();
    labels.push(timeStr);
    voltageData.push(d.voltage || 0);
    powerData.push(d.power || 0);
    if (labels.length > 20) {
      labels.shift();
      voltageData.shift();
      powerData.shift();
    }
    voltageChart.update();
    powerChart.update();

    // 2. UPDATE TEXT READINGS + LIVE BILL
    if (d.energy_kWh !== undefined) {
      totalUnitsEl.innerText = d.energy_kWh.toFixed(2);

      const used = d.units_used || 0;
      usedUnitsEl.innerText = used.toFixed(2);

      // ⚡ CALCULATE BILL LIVE AND UPDATE DOM
      const currentCost = calculateBill(used);
      amountEl.innerText = currentCost.toFixed(2);
    }
  } catch (e) {
    /* silent fail */
  }
}

/* ---------- BILLING & CALENDAR ---------- */
let billingHistory = [];
let curM = new Date().getMonth(),
  curY = new Date().getFullYear();

window.takeReading = async () => {
  takeBtn.disabled = true;
  takeBtn.innerText = "Processing...";
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${BACKEND}/billing/take-reading`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });
  const data = await res.json();

  // Update amount but calculateBill() inside fetchLive will keep overwriting it,
  // which is fine because they should match.
  amountEl.innerText = (data.amount || 0).toFixed(2);

  await loadBillingHistory();
  takeBtn.innerText = "Take New Reading";
  takeBtn.disabled = false;
};

async function loadBillingHistory() {
  if (!auth.currentUser) return;
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${BACKEND}/billing/history`, {
    headers: { Authorization: "Bearer " + token },
  });
  const data = await res.json();
  billingHistory = data ? Object.values(data) : [];
  renderCalendar();
}

function renderCalendar() {
  const grid = document.getElementById("calendarGrid");
  const monthLab = document.getElementById("calendarMonth");
  grid.innerHTML = "";

  const firstDay = new Date(curY, curM, 1).getDay();
  const daysInMonth = new Date(curY, curM + 1, 0).getDate();
  monthLab.innerText = new Date(curY, curM).toLocaleString("default", {
    month: "long",
    year: "numeric",
  });

  // Empty slots for previous month days
  for (let i = 0; i < firstDay; i++)
    grid.innerHTML += `<div class="calendar-day" style="opacity:0"></div>`;

  // Draw actual days
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = new Date(curY, curM, d).toDateString();

    // Find all bills for this specific day
    const dayBills = billingHistory.filter(
      (b) => new Date(b.to_ts * 1000).toDateString() === dateStr,
    );

    // Calculate total cost for the day
    const dayTotal = dayBills.reduce((sum, b) => sum + (b.amount || 0), 0);
    const hasReading = dayBills.length > 0;

    // DEBUG: Print to console if we find a bill so you can verify the date
    if (hasReading) {
      console.log(`Found reading for ${dateStr}: ₹${dayTotal}`);
    }

    // STYLE LOGIC:
    // 1. If we have a reading (even if ₹0), show a light green background.
    // 2. If the amount is > 0, show the price text.
    let cellStyle = "";
    let content = "";

    if (hasReading) {
      cellStyle =
        "background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.4);";
      if (dayTotal > 0) {
        content = `<div class="calendar-amount">₹${dayTotal.toFixed(0)}</div>`;
      } else {
        // Show a small checkmark or text for ₹0 readings (Baseline)
        content = `<div class="calendar-amount" style="opacity:0.7">✓</div>`;
      }
    }

    grid.innerHTML += `
        <div class="calendar-day" style="${cellStyle}">
          <span>${d}</span>
          ${content}
        </div>`;
  }
}

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

window.openDeviceModal = () =>
  (document.getElementById("deviceModal").style.display = "flex");
window.closeDeviceModal = () =>
  (document.getElementById("deviceModal").style.display = "none");
window.registerDevice = async () => {
  const id = document.getElementById("deviceId").value;
  if (!id) return alert("Enter ID");
  const token = await auth.currentUser.getIdToken();
  await fetch(`${BACKEND}/register-device?device_id=${id}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });
  closeDeviceModal();
  loadDevices();
};

/* ---------- INTERVALS ---------- */
setInterval(fetchLive, 3000);
setInterval(loadDevices, 10000);
