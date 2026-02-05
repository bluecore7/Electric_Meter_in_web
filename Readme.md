# ⚡ Smart Meter Web Dashboard (EnergyFlow)

A full-stack IoT project that simulates a smart electric meter using ESP8266 and displays
live energy usage, billing, and history through a modern web dashboard.

---

## 🔧 Tech Stack

### Hardware
- ESP8266 (simulated smart meter)

### Backend
- FastAPI (Python)
- Firebase Realtime Database
- Firebase Authentication
- Hosted on Render

### Frontend
- HTML / CSS / JavaScript
- Chart.js
- Firebase Hosting & Auth

---

## 🚀 Features

- Live voltage & power graphs
- Energy (kWh) tracking
- Domestic billing logic (India – slab based)
- Calendar-based billing history
- Multi-user & multi-device support
- Secure Firebase authentication
- Glassmorphic modern UI

---

## 📊 Billing Slabs (Demo)

| Units | Rate |
|------|------|
| 0–100 | Free |
| 101–200 | ₹2.25 / unit |
| 201–500 | ₹4.50 / unit |
| >500 | ₹6.60 / unit |

---

## 🧠 How It Works

1. ESP8266 simulates voltage/current and sends data every 5 seconds
2. Backend stores live data in Firebase
3. Users authenticate via Firebase Auth
4. Frontend fetches live data + billing via backend APIs
5. Billing readings are taken manually and stored per date

---

## 🛠 Setup (Local)

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
