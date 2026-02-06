from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from firebase import get_db
from auth import verify_user
from models import DevicePayload

# ---------------- BILL CALCULATION LOGIC ----------------
def calculate_bill(units):
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

# ---------------- LIST DEVICES ----------------
@app.get("/devices")
def list_devices(uid=Depends(verify_user)):
    db = get_db()
    user_data = db.child("users").child(uid).get()
    
    if not user_data or "device_id" not in user_data:
        return []

    device_id = user_data["device_id"]
    live_data = db.child("devices").child(device_id).child("live").get()
    
    last_seen = 0
    if live_data and "timestamp" in live_data:
        last_seen = live_data["timestamp"]

    return [{"device_id": device_id, "last_seen": last_seen}]

# ---------------- ESP32 INPUT ----------------
@app.post("/device/live")
def device_live(data: DevicePayload):
    db = get_db()
    db.child("devices").child(data.device_id).child("live").update({
        "voltage": data.voltage,
        "power": data.power,
        "energy_kWh": data.energy_kWh,
        "timestamp": data.timestamp
    })
    return {"status": "ok"}

# ---------------- LIVE DATA + BACKEND CALCULATION ----------------
@app.get("/live")
def get_live(uid=Depends(verify_user)):
    db = get_db()
    
    # 1. Get User's Device
    user = db.child("users").child(uid).get()
    if not user or "device_id" not in user:
        return {"error": "No device registered"}

    device_id = user["device_id"]
    
    # 2. Get Live Data
    live = db.child("devices").child(device_id).child("live").get()
    if not live:
        return {"voltage": 0, "power": 0, "energy_kWh": 0, "units_used": 0, "current_bill": 0}

    # 3. Get Last Bill (Baseline)
    bills = db.child("users").child(uid).child("bills").get()
    current_kwh = live.get("energy_kWh", 0)
    last_bill_kwh = 0

    if bills:
        bill_list = sorted(bills.values(), key=lambda x: x.get('to_ts', 0))
        last_bill = bill_list[-1]
        last_bill_kwh = last_bill.get("energy_end", 0)

    # 4. Calculate Units Used
    units_used = max(0, round(current_kwh - last_bill_kwh, 4))
    
    # 5. Calculate Cost (BACKEND LOGIC)
    current_bill_amount = calculate_bill(units_used)

    # 6. Store calculated values in Firebase (So they persist)
    db.child("devices").child(device_id).child("live").update({
        "units_used": units_used,
        "current_bill": current_bill_amount
    })

    # 7. Return everything to Frontend
    return {
        **live,
        "units_used": units_used,
        "current_bill": current_bill_amount
    }

# ---------------- BILLING HISTORY ----------------
@app.post("/billing/take-reading")
def take_reading(uid=Depends(verify_user)):
    db = get_db()
    user = db.child("users").child(uid).get()
    if not user or "device_id" not in user:
         raise HTTPException(status_code=400, detail="No device found")
         
    device_id = user["device_id"]
    live = db.child("devices").child(device_id).child("live").get()
    
    if not live:
        return {"error": "No live data"}

    # Use the live values we already calculated
    energy_now = live.get("energy_kWh", 0)
    ts_now = live.get("timestamp", 0)
    
    bills_ref = db.child("users").child(uid).child("bills")
    bills = bills_ref.get() or {}

    # First Bill
    if not bills:
        bills_ref.push({
            "energy_start": energy_now,
            "energy_end": energy_now,
            "from_ts": ts_now,
            "to_ts": ts_now,
            "units": 0,
            "amount": 0
        })
        return {"message": "Baseline reading recorded", "amount": 0}

    # Subsequent Bills
    bill_list = sorted(bills.values(), key=lambda x: x.get('to_ts', 0))
    last_bill = bill_list[-1]
    energy_prev = last_bill["energy_end"]

    units = round(energy_now - energy_prev, 4)
    amount = calculate_bill(units)

    bills_ref.push({
        "energy_start": energy_prev,
        "energy_end": energy_now,
        "from_ts": last_bill["to_ts"],
        "to_ts": ts_now,
        "units": units,
        "amount": amount
    })

    return {"units": units, "amount": amount}

@app.get("/billing/history")
def billing_history(uid=Depends(verify_user)):
    db = get_db()
    return db.child("users").child(uid).child("bills").get()