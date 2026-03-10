# main.py — EnergyFlow Backend v2.0
# Run: uvicorn main:app --host 0.0.0.0 --port 8000

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from firebase import get_db
from auth import verify_user
from models import DevicePayload
import time

# ============================================================
#  TNEB TARIFF BILL CALCULATION
# ============================================================
def calculate_bill(units: float) -> float:
    """Calculate TNEB domestic bill (LT-I) from units consumed."""
    if units <= 0:
        return 0.0
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

def get_fixed_charge(units: float) -> float:
    if units <= 100: return 45.0
    if units <= 200: return 75.0
    if units <= 500: return 115.0
    return 155.0

# ============================================================
#  APP SETUP
# ============================================================
app = FastAPI(title="EnergyFlow Backend v2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "EnergyFlow Backend v2.0 running", "endpoints": [
        "GET  /devices", "POST /register-device",
        "POST /device/live", "GET  /live",
        "POST /billing/take-reading", "GET  /billing/history",
        "GET  /stats/hourly", "GET  /stats/summary"
    ]}

# ============================================================
#  DEVICE MANAGEMENT
# ============================================================
@app.post("/register-device")
def register_device(device_id: str, uid=Depends(verify_user)):
    db = get_db()
    db.child("users").child(uid).set({"device_id": device_id})
    db.child("devices").child(device_id).child("owner").set(uid)
    return {"message": f"Device {device_id} registered to user {uid}"}

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

# ============================================================
#  LIVE DATA — ESP32 POSTS HERE
# ============================================================
@app.post("/device/live")
def device_live(data: DevicePayload):
    """Receive live readings from ESP32. Also stores hourly snapshot."""
    db = get_db()

    # Update live reading
    db.child("devices").child(data.device_id).child("live").set({
        "voltage": data.voltage,
        "current": data.current,
        "power": data.power,
        "energy_kWh": data.energy_kWh,
        "timestamp": data.timestamp
    })

    # Store hourly snapshot for analytics (keyed by hour)
    # Key format: YYYY-MM-DD_HH (one record per hour per device)
    from datetime import datetime, timezone
    dt = datetime.fromtimestamp(data.timestamp, tz=timezone.utc)
    hour_key = dt.strftime("%Y-%m-%d_%H")

    hourly_ref = db.child("devices").child(data.device_id).child("hourly").child(hour_key)
    existing = hourly_ref.get() or {}

    # Accumulate for averaging
    count = existing.get("count", 0) + 1
    hourly_ref.set({
        "voltage_sum": existing.get("voltage_sum", 0) + data.voltage,
        "current_sum": existing.get("current_sum", 0) + data.current,
        "power_sum":   existing.get("power_sum", 0) + data.power,
        "energy_max":  max(existing.get("energy_max", 0), data.energy_kWh),
        "energy_min":  min(existing.get("energy_min", data.energy_kWh), data.energy_kWh),
        "count":       count,
        "hour":        hour_key,
        "timestamp":   data.timestamp
    })

    return {"status": "ok", "hour": hour_key}

# ============================================================
#  GET LIVE DATA (for web dashboard)
# ============================================================
@app.get("/live")
def get_live(uid=Depends(verify_user)):
    db = get_db()

    user = db.child("users").child(uid).get()
    if not user or "device_id" not in user:
        return {"error": "No device registered"}

    device_id = user["device_id"]
    live = db.child("devices").child(device_id).child("live").get()
    if not live:
        return {"voltage": 0, "current": 0, "power": 0, "energy_kWh": 0, "units_used": 0}

    bills = db.child("users").child(uid).child("bills").get()
    current_kwh = live.get("energy_kWh", 0)
    last_bill_kwh = 0

    if bills:
        bill_list = sorted(bills.values(), key=lambda x: x.get("to_ts", 0))
        last_bill_kwh = bill_list[-1].get("energy_end", 0)

    units_used = max(0, round(current_kwh - last_bill_kwh, 5))

    return {
        **live,
        "units_used": units_used
    }

# ============================================================
#  STATS — HOURLY ANALYTICS
# ============================================================
@app.get("/stats/hourly")
def stats_hourly(uid=Depends(verify_user), days: int = 1):
    """Return averaged hourly stats for the last N days."""
    db = get_db()
    user = db.child("users").child(uid).get()
    if not user or "device_id" not in user:
        return {"error": "No device"}

    device_id = user["device_id"]
    hourly_data = db.child("devices").child(device_id).child("hourly").get()

    if not hourly_data:
        return []

    # Filter to requested date range
    from datetime import datetime, timezone, timedelta
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
    cutoff_str = cutoff.strftime("%Y-%m-%d_%H")

    result = []
    for key, val in hourly_data.items():
        if key >= cutoff_str and val.get("count", 0) > 0:
            count = val["count"]
            energy_delta = max(0, val.get("energy_max", 0) - val.get("energy_min", 0))
            result.append({
                "hour": key,
                "avg_voltage": round(val.get("voltage_sum", 0) / count, 2),
                "avg_current": round(val.get("current_sum", 0) / count, 4),
                "avg_power":   round(val.get("power_sum", 0) / count, 2),
                "energy_kwh":  round(energy_delta, 5),
                "samples":     count,
                "timestamp":   val.get("timestamp", 0)
            })

    return sorted(result, key=lambda x: x["hour"])

@app.get("/stats/summary")
def stats_summary(uid=Depends(verify_user)):
    """Return peak power, avg power, voltage stats for the current day."""
    hourly = stats_hourly(uid=uid, days=1)
    if not hourly or isinstance(hourly, dict):
        return {}

    powers   = [h["avg_power"] for h in hourly if h["avg_power"] > 0]
    voltages = [h["avg_voltage"] for h in hourly if h["avg_voltage"] > 0]
    total_energy = sum(h["energy_kwh"] for h in hourly)

    return {
        "peak_power":  max(powers) if powers else 0,
        "avg_power":   round(sum(powers) / len(powers), 2) if powers else 0,
        "min_voltage": min(voltages) if voltages else 0,
        "max_voltage": max(voltages) if voltages else 0,
        "total_energy_today": round(total_energy, 4),
        "hours_recorded": len(hourly)
    }

# ============================================================
#  BILLING
# ============================================================
@app.post("/billing/take-reading")
def take_reading(uid=Depends(verify_user)):
    db = get_db()

    user = db.child("users").child(uid).get()
    if not user or "device_id" not in user:
        raise HTTPException(status_code=400, detail="No device found")

    device_id = user["device_id"]
    live = db.child("devices").child(device_id).child("live").get()

    if not live:
        raise HTTPException(status_code=404, detail="No live data available")

    energy_now = live.get("energy_kWh", 0)
    ts_now = live.get("timestamp", int(time.time()))

    bills_ref = db.child("users").child(uid).child("bills")
    bills = bills_ref.get() or {}

    if not bills:
        # First reading = baseline
        bills_ref.push({
            "energy_start": energy_now,
            "energy_end": energy_now,
            "from_ts": ts_now,
            "to_ts": ts_now,
            "units": 0,
            "amount": 0
        })
        return {"message": "Baseline reading recorded", "units": 0, "amount": 0}

    bill_list = sorted(bills.values(), key=lambda x: x.get("to_ts", 0))
    last_bill = bill_list[-1]
    energy_prev = last_bill.get("energy_end", 0)

    units = round(max(0, energy_now - energy_prev), 5)
    amount = calculate_bill(units)
    fixed = get_fixed_charge(units)

    bills_ref.push({
        "energy_start": energy_prev,
        "energy_end": energy_now,
        "from_ts": last_bill.get("to_ts", ts_now),
        "to_ts": ts_now,
        "units": units,
        "amount": amount,
        "fixed_charge": fixed,
        "total": round(amount + fixed, 2)
    })

    return {"units": units, "amount": amount, "fixed_charge": fixed, "total": round(amount + fixed, 2)}

@app.get("/billing/history")
def billing_history(uid=Depends(verify_user)):
    db = get_db()
    return db.child("users").child(uid).child("bills").get() or {}

# ============================================================
#  POWER OUTAGE LOGGING — ESP32 posts here when power returns
# ============================================================
class OutagePayload(BaseModel):
    device_id: str
    start_ts:  int       # Unix timestamp when power went off
    end_ts:    int       # Unix timestamp when power came back
    duration:  int       # seconds

@app.post("/device/outage")
def log_outage(data: OutagePayload):
    """
    Called by ESP32 when power is restored after an outage.
    Stores outage record under devices/{device_id}/outages/{key}
    Also stores under users/{uid}/outages for dashboard lookup.
    """
    db = get_db()

    # Find owner of this device
    owner = db.child("devices").child(data.device_id).child("owner").get()

    outage_record = {
        "device_id": data.device_id,
        "start_ts":  data.start_ts,
        "end_ts":    data.end_ts,
        "duration":  data.duration,
        "duration_min": round(data.duration / 60, 2),
        "logged_at": int(__import__("time").time())
    }

    # Save under device
    db.child("devices").child(data.device_id).child("outages").push(outage_record)

    # Save under user for easy dashboard lookup
    if owner:
        db.child("users").child(owner).child("outages").push(outage_record)

    return {
        "status": "ok",
        "duration_min": outage_record["duration_min"]
    }

@app.get("/outages")
def get_outages(uid=Depends(verify_user)):
    """Return all recorded power outages for this user's device."""
    db = get_db()
    raw = db.child("users").child(uid).child("outages").get() or {}
    if not raw:
        return []
    outages = list(raw.values())
    return sorted(outages, key=lambda x: x.get("start_ts", 0), reverse=True)

@app.get("/outages/stats")
def outage_stats(uid=Depends(verify_user)):
    """Summary stats: total outages, total downtime, longest outage."""
    db = get_db()
    raw = db.child("users").child(uid).child("outages").get() or {}
    if not raw:
        return {"total_outages": 0, "total_downtime_min": 0, "longest_min": 0}
    outages = list(raw.values())
    durations = [o.get("duration", 0) for o in outages]
    return {
        "total_outages":     len(outages),
        "total_downtime_min": round(sum(durations) / 60, 2),
        "longest_min":        round(max(durations) / 60, 2),
        "avg_duration_min":   round((sum(durations) / len(durations)) / 60, 2)
    }