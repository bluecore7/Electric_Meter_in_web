from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from firebase import get_db
from auth import verify_user
from models import DevicePayload

# ---------------- BILL CALCULATION ----------------
def calculate_bill(units: float) -> float:
    cost = 0.0
    if units <= 100:
        return 0.0
    if units > 100:
        cost += min(units - 100, 100) * 2.25
    if units > 200:
        cost += min(units - 200, 300) * 4.50
    if units > 500:
        cost += (units - 500) * 6.60
    return round(cost, 2)

# ---------------- APP SETUP ----------------
app = FastAPI(title="EnergyFlow Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "Backend running"}

# ---------------- REGISTER DEVICE ----------------
@app.post("/register-device")
def register_device(device_id: str, uid=Depends(verify_user)):
    db = get_db()
    db.child("users").child(uid).set({"device_id": device_id})
    db.child("devices").child(device_id).child("owner").set(uid)
    return {"message": "Device registered"}

# ---------------- ESP LIVE DATA ----------------
@app.post("/device/live")
def device_live(data: DevicePayload):
    db = get_db()
    db.child("devices").child(data.device_id).child("live").set({
        "voltage": data.voltage,
        "power": data.power,
        "energy_kWh": data.energy_kWh,
        "timestamp": data.timestamp
    })
    return {"status": "ok"}

# ---------------- GET LIVE DATA ----------------
@app.get("/live")
def get_live(uid=Depends(verify_user)):
    db = get_db()

    user = db.child("users").child(uid).get()
    if not user or "device_id" not in user:
        raise HTTPException(400, "No device registered")

    device_id = user["device_id"]
    live = db.child("devices").child(device_id).child("live").get()

    if not live:
        return {
            "voltage": 0,
            "power": 0,
            "energy_kWh": 0,
            "units_used": 0,
            "last_bill_amount": 0
        }

    bills = db.child("users").child(uid).child("bills").get() or {}

    last_energy = 0
    last_amount = 0

    if bills:
        last_bill = sorted(bills.values(), key=lambda x: x["to_ts"])[-1]
        last_energy = last_bill["energy_end"]
        last_amount = last_bill["amount"]

    units_used = round(live["energy_kWh"] - last_energy, 4)

    return {
        **live,
        "units_used": max(units_used, 0),
        "last_bill_amount": last_amount
    }

# ---------------- TAKE BILLING READING ----------------
@app.post("/billing/take-reading")
def take_reading(uid=Depends(verify_user)):
    db = get_db()

    user = db.child("users").child(uid).get()
    if not user or "device_id" not in user:
        raise HTTPException(400, "No device found")

    device_id = user["device_id"]
    live = db.child("devices").child(device_id).child("live").get()
    if not live:
        raise HTTPException(400, "No live data")

    energy_now = live["energy_kWh"]
    ts_now = live["timestamp"]

    bills_ref = db.child("users").child(uid).child("bills")
    bills = bills_ref.get() or {}

    if not bills:
        bills_ref.push({
            "energy_start": energy_now,
            "energy_end": energy_now,
            "from_ts": ts_now,
            "to_ts": ts_now,
            "units": 0,
            "amount": 0
        })
        return {"amount": 0}

    last_bill = sorted(bills.values(), key=lambda x: x["to_ts"])[-1]
    units = round(energy_now - last_bill["energy_end"], 4)
    amount = calculate_bill(units)

    bills_ref.push({
        "energy_start": last_bill["energy_end"],
        "energy_end": energy_now,
        "from_ts": last_bill["to_ts"],
        "to_ts": ts_now,
        "units": units,
        "amount": amount
    })

    return {"units": units, "amount": amount}

# ---------------- BILL HISTORY ----------------
@app.get("/billing/history")
def billing_history(uid=Depends(verify_user)):
    db = get_db()
    return db.child("users").child(uid).child("bills").get()

@app.get("/devices")
def list_devices(uid=Depends(verify_user)):
    db = get_db()
    user = db.child("users").child(uid).get()

    if not user or "device_id" not in user:
        return []

    device_id = user["device_id"]
    live = db.child("devices").child(device_id).child("live").get() or {}

    return [{
        "device_id": device_id,
        "last_seen": live.get("timestamp", 0)
    }]
