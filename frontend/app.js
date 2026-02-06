import { auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const BACKEND = "https://electric-meter-in-web.onrender.com";

/* ---------- DOM ---------- */
const authDiv = document.getElementById("authDiv");
const dashboardDiv = document.getElementById("dashboardDiv");
const amountEl = document.getElementById("amount");
const totalUnitsEl = document.getElementById("totalUnits");
const usedUnitsEl = document.getElementById("usedUnits");
const takeBtn = document.getElementById("takeBtn");

/* ---------- AUTH ---------- */
window.signup = async () => {
  await createUserWithEmailAndPassword(auth, email.value, password.value);
};

window.login = async () => {
  await signInWithEmailAndPassword(auth, email.value, password.value);
};

window.logout = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  if (user) {
    authDiv.style.display = "none";
    dashboardDiv.style.display = "block";
    loadBillingHistory();
    fetchLive();
  } else {
    authDiv.style.display = "grid";
    dashboardDiv.style.display = "none";
  }
});

/* ---------- LIVE DATA ---------- */
async function fetchLive() {
  if (!auth.currentUser) return;

  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${BACKEND}/live`, {
    headers: { Authorization: "Bearer " + token },
  });

  if (!res.ok) return;
  const d = await res.json();

  totalUnitsEl.innerText = d.energy_kWh?.toFixed(2) || "0.00";
  usedUnitsEl.innerText = d.units_used?.toFixed(2) || "0.00";
  amountEl.innerText = d.last_bill_amount?.toFixed(2) || "0.00";
}

/* ---------- BILLING ---------- */
window.takeReading = async () => {
  takeBtn.disabled = true;

  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${BACKEND}/billing/take-reading`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });

  const data = await res.json();
  amountEl.innerText = data.amount.toFixed(2);

  await loadBillingHistory();
  takeBtn.disabled = false;
};

/* ---------- CALENDAR ---------- */
let billingHistory = [];

async function loadBillingHistory() {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${BACKEND}/billing/history`, {
    headers: { Authorization: "Bearer " + token },
  });
  const data = await res.json();
  billingHistory = data ? Object.values(data) : [];
  renderCalendar();
}
