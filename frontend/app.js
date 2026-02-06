import { auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

// ⚠️ REPLACE WITH YOUR RENDER URL
const BACKEND = "https://energyflow-esp32.onrender.com";

/* ---------- DOM ELEMENTS ---------- */
const authDiv = document.getElementById("authDiv");
const dashboardDiv = document.getElementById("dashboardDiv");
const amountEl = document.getElementById("amount");
const takeBtn = document.getElementById("takeBtn");
const logoutBtn = document.getElementById("logoutBtn");
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
      list.innerHTML = `<p style="opacity:0.5; font-size:12px">No devices found.</p>`;
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

const voltageChart = new Chart(
  document.getElementById("voltageChart"),
  chartConfig("Voltage", voltageData, "#38bdf8", "rgba(56, 189, 248, 0.1)"),
);
const powerChart = new Chart(
  document.getElementById("powerChart"),
  chartConfig("Power", powerData, "#6366f1", "rgba(99, 102, 241, 0.1)"),
);

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

    // 2. UPDATE TEXT (DATA COMES FROM BACKEND NOW)
    if (d.energy_kWh !== undefined) {
      totalUnitsEl.innerText = d.energy_kWh.toFixed(2);
      usedUnitsEl.innerText = (d.units_used || 0).toFixed(2);

      // ✅ SIMPLIFIED: Just read the backend value
      amountEl.innerText = (d.current_bill || 0).toFixed(2);
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

  for (let i = 0; i < firstDay; i++)
    grid.innerHTML += `<div class="calendar-day" style="opacity:0"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = new Date(curY, curM, d).toDateString();
    const dayBills = billingHistory.filter(
      (b) => new Date(b.to_ts * 1000).toDateString() === dateStr,
    );
    const dayTotal = dayBills.reduce((sum, b) => sum + (b.amount || 0), 0);
    const hasReading = dayBills.length > 0;

    let style = "";
    let content = "";
    if (hasReading) {
      style =
        "background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.4);";
      content =
        dayTotal > 0
          ? `<div class="calendar-amount">₹${dayTotal.toFixed(0)}</div>`
          : `<div class="calendar-amount" style="opacity:0.7">✓</div>`;
    }

    grid.innerHTML += `
      <div class="calendar-day" style="${style}">
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
