# main.py — EnergyFlow Production Backend v3.0
# All user data persisted in Firebase Realtime Database
# Cross-device sync guaranteed — reading from DB on every request

from fastapi import FastAPI, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from firebase import get_db
from auth import verify_user
from models import DevicePayload, OutagePayload, UserProfile
import time
from datetime import datetime, timezone, timedelta
from typing import Optional
import joblib
import numpy as np
import pandas as pd
import math
import os

# India Standard Time (UTC+5:30)
IST = timezone(timedelta(hours=5, minutes=30))

def now_ist():
    return datetime.now(tz=IST)

def ts_to_ist(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz=IST)

# ============================================================
#  TNEB TARIFF ENGINE
# ============================================================
def calculate_bill(units: float) -> float:
    """
    TNEB Monthly Slab Tariff (LT-I Domestic):
      0  – 50  units : Free
      51 – 200 units : ₹4.70 / unit  (on units above 50)
      201– 250 units : ₹6.30 / unit  (on units above 200)
      251– 300 units : ₹8.40 / unit  (on units above 250)
      301– 400 units : ₹9.45 / unit  (on units above 300)
      401– 500 units : ₹10.50 / unit (on units above 400)
      Above 500      : ₹11.55 / unit (on units above 500)
    """
    if units <= 0:   return 0.0
    cost = 0.0
    if units > 50:   cost += min(units - 50,  150) * 4.70   # 51–200
    if units > 200:  cost += min(units - 200,   50) * 6.30   # 201–250
    if units > 250:  cost += min(units - 250,   50) * 8.40   # 251–300
    if units > 300:  cost += min(units - 300,  100) * 9.45   # 301–400
    if units > 400:  cost += min(units - 400,  100) * 10.50  # 401–500
    if units > 500:  cost += (units - 500)          * 11.55  # Above 500
    return round(cost, 2)

def get_fixed_charge(units: float) -> float:
    if units <= 100: return 45.0
    if units <= 200: return 75.0
    if units <= 500: return 115.0
    return 155.0

def get_slab_label(units: float) -> str:
    if units <= 50:  return "Slab 1 — Free (0–50 units)"
    if units <= 200: return "Slab 2 — ₹4.70/unit (51–200)"
    if units <= 250: return "Slab 3 — ₹6.30/unit (201–250)"
    if units <= 300: return "Slab 4 — ₹8.40/unit (251–300)"
    if units <= 400: return "Slab 5 — ₹9.45/unit (301–400)"
    if units <= 500: return "Slab 6 — ₹10.50/unit (401–500)"
    return "Slab 7 — ₹11.55/unit (Above 500)"

# ============================================================
#  APP SETUP
# ============================================================
app = FastAPI(
    title="EnergyFlow API",
    description="Production energy monitoring backend — all data persisted per user",
    version="3.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# ============================================================
#  HEALTH
# ============================================================
@app.get("/", tags=["Health"])
def root():
    return {
        "status": "EnergyFlow v3.0 running",
        "timestamp": int(time.time()),
        "docs": "/docs"
    }

@app.get("/health", tags=["Health"])
def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}

# ============================================================
#  USER PROFILE  — persisted in Firebase
# ============================================================
@app.get("/user/profile", tags=["User"])
def get_profile(uid=Depends(verify_user)):
    db = get_db()
    profile = db.child("users").child(uid).child("profile").get() or {}
    return {
        "uid": uid,
        "display_name":  profile.get("display_name", ""),
        "phone":         profile.get("phone", ""),
        "address":       profile.get("address", ""),
        "eb_consumer_no":profile.get("eb_consumer_no", ""),
        "tariff_type":   profile.get("tariff_type", "LT-I"),
        "sanctioned_load":profile.get("sanctioned_load", 5),
        "created_at":    profile.get("created_at", int(time.time())),
        "device_id":     db.child("users").child(uid).child("device_id").get() or ""
    }

@app.post("/user/profile", tags=["User"])
def update_profile(profile: UserProfile, uid=Depends(verify_user)):
    db = get_db()
    existing = db.child("users").child(uid).child("profile").get() or {}
    updated = {**existing, **profile.dict(exclude_none=True)}
    if "created_at" not in updated:
        updated["created_at"] = int(time.time())
    updated["updated_at"] = int(time.time())
    db.child("users").child(uid).child("profile").set(updated)
    return {"status": "ok", "profile": updated}

# ============================================================
#  DEVICE MANAGEMENT
# ============================================================
@app.post("/register-device", tags=["Device"])
def register_device(device_id: str, uid=Depends(verify_user)):
    """Join a shared household device. First user becomes owner; subsequent
    users become members — all see the same real-time data."""
    db = get_db()
    # Link user → device
    db.child("users").child(uid).child("device_id").set(device_id)

    # Only set owner if no owner exists yet (first registration = owner)
    existing_owner = db.child("devices").child(device_id).child("owner").get()
    if not existing_owner:
        db.child("devices").child(device_id).child("owner").set(uid)
        db.child("devices").child(device_id).child("registered_at").set(int(time.time()))
        role = "owner"
    else:
        role = "member"

    # Add to members list (works for both owner and additional members)
    db.child("devices").child(device_id).child("members").child(uid).set(True)

    return {
        "message": f"Joined device {device_id} as {role}. All household members share live data.",
        "device_id": device_id,
        "role": role,
    }

@app.get("/devices", tags=["Device"])
def list_devices(uid=Depends(verify_user)):
    db = get_db()
    device_id = db.child("users").child(uid).child("device_id").get()
    if not device_id:
        return []
    live = db.child("devices").child(device_id).child("live").get() or {}
    registered_at = db.child("devices").child(device_id).child("registered_at").get() or 0
    return [{
        "device_id":     device_id,
        "last_seen":     live.get("timestamp", 0),
        "registered_at": registered_at,
        "voltage":       live.get("voltage", 0),
        "power":         live.get("power", 0),
    }]

# ============================================================
#  LIVE DATA — ESP32 posts here every 3 seconds
# ============================================================
@app.post("/device/live", tags=["Device"])
def device_live(data: DevicePayload):
    """
    Receives live readings from ESP32 every 3 seconds.

    ENERGY PERSISTENCE ACROSS REBOOTS:
    ─────────────────────────────────
    The ESP32 tracks energy_kWh starting from 0 each boot
    (even with flash storage, a sudden power cut may lose recent values).
    We store a base_energy_kWh in Firebase so that:

        true_cumulative = base_energy + esp_reported_energy

    When we detect a reboot (esp energy dropped vs last known value),
    we promote the last true_cumulative to the new base before adding.
    This means the meter reading in the app NEVER goes backward.

    TIMEZONE:
    ─────────
    All time bucketing is done in IST (UTC+5:30) so hour keys
    match the user's local clock (8pm IST = hour 20, not 14).
    """
    db = get_db()
    ts = data.timestamp
    dt = ts_to_ist(ts)   # ← IST, not UTC

    # ═══════════════════════════════════════════════════════
    #  ENERGY CONTINUITY — the core persistence mechanism
    # ═══════════════════════════════════════════════════════
    energy_ref  = db.child("devices").child(data.device_id).child("energy")
    energy_doc  = energy_ref.get() or {}

    base_energy   = energy_doc.get("base_kWh", 0.0)      # total kWh before last reboot
    last_esp_kwh  = energy_doc.get("last_esp_kWh", -1.0) # last value ESP reported
    last_true_kwh = energy_doc.get("true_kWh", 0.0)      # last stored true cumulative

    esp_kwh = data.energy_kWh  # what the ESP says (resets to ~0 after each reboot)

    # Detect reboot: ESP energy dropped by more than 0.01 kWh from last known value
    # (small drops can happen from floating point, so use 0.01 as minimum drop threshold)
    reboot_detected = (last_esp_kwh >= 0) and (esp_kwh < last_esp_kwh - 0.01)

    if reboot_detected:
        # ESP restarted — promote last true cumulative to the new base
        # From now on: true = new_base + new_esp_readings
        base_energy = last_true_kwh
        energy_ref.set({
            "base_kWh":     base_energy,
            "last_esp_kWh": esp_kwh,
            "true_kWh":     base_energy + esp_kwh,
            "reboot_count": energy_doc.get("reboot_count", 0) + 1,
            "last_reboot_ts": ts,
        })
    else:
        # Normal reading — just update running values
        true_kwh = base_energy + esp_kwh
        energy_ref.set({
            "base_kWh":     base_energy,
            "last_esp_kWh": esp_kwh,
            "true_kWh":     true_kwh,
            "reboot_count": energy_doc.get("reboot_count", 0),
            "last_reboot_ts": energy_doc.get("last_reboot_ts", 0),
        })

    true_cumulative_kwh = base_energy + esp_kwh

    # ── 1. Live snapshot — store true cumulative, not raw esp value
    db.child("devices").child(data.device_id).child("live").set({
        "voltage":          data.voltage,
        "current":          data.current,
        "power":            data.power,
        "energy_kWh":       true_cumulative_kwh,   # ← true meter reading
        "esp_energy_kWh":   esp_kwh,               # ← raw ESP value (for debugging)
        "base_energy_kWh":  base_energy,
        "timestamp":        ts,
        "reboot_detected":  reboot_detected,
    })

    is_outage_reading = data.voltage < 50

    # ── 2. Hourly aggregate — keyed by IST hour
    hour_key = dt.strftime("%Y-%m-%d_%H")   # e.g. "2025-10-03_20" for 8pm IST
    hourly_ref = db.child("devices").child(data.device_id).child("hourly").child(hour_key)
    existing = hourly_ref.get() or {}
    count = existing.get("count", 0) + 1

    if is_outage_reading:
        hourly_ref.set({
            **existing,
            "count":          count,
            "outage_samples": existing.get("outage_samples", 0) + 1,
            "timestamp":      ts,
            "date":           dt.strftime("%Y-%m-%d"),
            "hour":           dt.hour,
        })
    else:
        active_count = existing.get("active_count", 0) + 1
        hourly_ref.set({
            "voltage_sum":    existing.get("voltage_sum", 0)    + data.voltage,
            "current_sum":    existing.get("current_sum", 0)    + data.current,
            "power_sum":      existing.get("power_sum", 0)      + data.power,
            "energy_max":     max(existing.get("energy_max", 0), true_cumulative_kwh),
            "energy_min":     min(existing.get("energy_min", true_cumulative_kwh), true_cumulative_kwh),
            "power_max":      max(existing.get("power_max", 0), data.power),
            "voltage_min":    min(existing.get("voltage_min", data.voltage), data.voltage),
            "voltage_max":    max(existing.get("voltage_max", 0), data.voltage),
            "count":          count,
            "active_count":   active_count,
            "outage_samples": existing.get("outage_samples", 0),
            "timestamp":      ts,
            "date":           dt.strftime("%Y-%m-%d"),
            "hour":           dt.hour,
        })

    # ── 3. Daily summary — keyed by IST date
    day_key = dt.strftime("%Y-%m-%d")
    day_ref = db.child("devices").child(data.device_id).child("daily").child(day_key)
    day_existing = day_ref.get() or {}
    day_count = day_existing.get("count", 0) + 1

    if is_outage_reading:
        day_ref.set({
            **day_existing,
            "count":          day_count,
            "outage_samples": day_existing.get("outage_samples", 0) + 1,
            "date":           day_key,
            "timestamp":      ts,
        })
    else:
        day_ref.set({
            "power_sum":      day_existing.get("power_sum", 0)    + data.power,
            "energy_max":     max(day_existing.get("energy_max", 0), true_cumulative_kwh),
            "energy_min":     min(day_existing.get("energy_min", true_cumulative_kwh), true_cumulative_kwh),
            "power_max":      max(day_existing.get("power_max", 0), data.power),
            "voltage_min":    min(day_existing.get("voltage_min", data.voltage), data.voltage),
            "voltage_max":    max(day_existing.get("voltage_max", 0), data.voltage),
            "count":          day_count,
            "outage_samples": day_existing.get("outage_samples", 0),
            "date":           day_key,
            "timestamp":      ts,
        })

    return {
        "status":           "ok",
        "hour":             hour_key,
        "day":              day_key,
        "true_kwh":         round(true_cumulative_kwh, 5),
        "reboot_detected":  reboot_detected,
    }

# ============================================================
#  LIVE DATA — Dashboard fetches this
# ============================================================
@app.get("/live", tags=["Live"])
def get_live(uid=Depends(verify_user)):
    db = get_db()
    device_id = db.child("users").child(uid).child("device_id").get()
    if not device_id:
        return {"error": "No device registered"}

    live = db.child("devices").child(device_id).child("live").get()
    if not live:
        return {"voltage": 0, "current": 0, "power": 0, "energy_kWh": 0, "units_used": 0, "timestamp": 0}

    # Use true cumulative kWh (base + esp) — this never goes backward after a reboot
    energy_doc  = db.child("devices").child(device_id).child("energy").get() or {}
    current_kwh = energy_doc.get("true_kWh", live.get("energy_kWh", 0))

    # Units used since last billing reading
    bills = db.child("users").child(uid).child("bills").get()
    last_bill_kwh = 0
    if bills:
        bill_list = sorted(bills.values(), key=lambda x: x.get("to_ts", 0))
        last_bill_kwh = bill_list[-1].get("energy_end", 0)

    units_used = max(0, round(current_kwh - last_bill_kwh, 5))
    bill_amt   = calculate_bill(units_used)
    fixed      = get_fixed_charge(units_used)

    return {
        **live,
        "units_used":     units_used,
        "bill_amount":    bill_amt,
        "fixed_charge":   fixed,
        "total_estimate": round(bill_amt + fixed, 2),
        "slab":           get_slab_label(units_used),
    }

# ============================================================
#  STATISTICS — Persistent, from Firebase, cross-device
# ============================================================
@app.get("/stats/hourly", tags=["Statistics"])
def stats_hourly(
    uid=Depends(verify_user),
    days: int = Query(default=1, ge=1, le=90)
):
    """
    Returns hourly averaged stats from Firebase.
    Persistent — same data on any device.
    """
    db = get_db()
    device_id = db.child("users").child(uid).child("device_id").get()
    if not device_id:
        return []

    hourly_raw = db.child("devices").child(device_id).child("hourly").get()
    if not hourly_raw:
        return []

    cutoff_dt  = now_ist() - timedelta(days=days)
    cutoff_key = cutoff_dt.strftime("%Y-%m-%d_%H")

    result = []
    for key, val in hourly_raw.items():
        if key < cutoff_key or not val or val.get("count", 0) == 0:
            continue
        # Use active_count (non-outage samples) for electrical averages
        # Using total count would dilute voltages/power with 0V outage readings
        c        = val.get("active_count", val["count"])   # fall back to count for old data
        outage_n = val.get("outage_samples", 0)
        if c == 0:
            continue  # this hour had only outage readings — skip from stats
        energy_delta = max(0, val.get("energy_max", 0) - val.get("energy_min", 0))
        result.append({
            "hour":           key,
            "date":           val.get("date", key[:10]),
            "hour_num":       val.get("hour", int(key[11:13]) if len(key) >= 13 else 0),
            "avg_voltage":    round(val.get("voltage_sum", 0) / c, 2),
            "avg_current":    round(val.get("current_sum", 0) / c, 4),
            "avg_power":      round(val.get("power_sum", 0) / c, 2),
            "max_power":      round(val.get("power_max", 0), 2),
            "min_voltage":    round(val.get("voltage_min", 0), 2),
            "max_voltage":    round(val.get("voltage_max", 0), 2),
            "energy_kwh":     round(energy_delta, 5),
            "samples":        c,
            "outage_samples": outage_n,    # how many 0V readings this hour
            "had_outage":     outage_n > 0,
            "timestamp":      val.get("timestamp", 0),
        })

    return sorted(result, key=lambda x: x["hour"])

@app.get("/stats/daily", tags=["Statistics"])
def stats_daily(uid=Depends(verify_user), days: int = Query(default=30, ge=1, le=365)):
    """Daily energy summaries for the last N days. Persistent in Firebase."""
    db = get_db()
    device_id = db.child("users").child(uid).child("device_id").get()
    if not device_id:
        return []

    daily_raw = db.child("devices").child(device_id).child("daily").get()
    if not daily_raw:
        return []

    cutoff = (now_ist() - timedelta(days=days)).strftime("%Y-%m-%d")
    result = []
    for key, val in daily_raw.items():
        if key < cutoff or not val or val.get("count", 0) == 0:
            continue
        c = val["count"]
        energy_delta = max(0, val.get("energy_max", 0) - val.get("energy_min", 0))
        result.append({
            "date":        key,
            "avg_power":   round(val.get("power_sum", 0) / c, 2),
            "max_power":   round(val.get("power_max", 0), 2),
            "min_voltage": round(val.get("voltage_min", 230), 2),
            "max_voltage": round(val.get("voltage_max", 0), 2),
            "energy_kwh":  round(energy_delta, 4),
            "est_bill":    round(calculate_bill(energy_delta) + get_fixed_charge(energy_delta), 2),
            "samples":     c,
        })

    return sorted(result, key=lambda x: x["date"])

@app.get("/stats/summary", tags=["Statistics"])
def stats_summary(uid=Depends(verify_user)):
    """Today's summary stats. Used by Statistics KPI bar."""
    hourly = stats_hourly(uid=uid, days=1)
    if not hourly or isinstance(hourly, dict):
        return {}
    powers    = [h["avg_power"]   for h in hourly if h["avg_power"] > 0]
    voltages  = [h["avg_voltage"] for h in hourly if h["avg_voltage"] > 0]
    energy    = sum(h["energy_kwh"] for h in hourly)
    # Exclude power-outage hours (avg_voltage near 0) — those are outages, not anomalies
    active_hours = [h for h in hourly if h.get("avg_voltage", 0) > 50]
    anomalies = [h for h in active_hours
                 if h.get("min_voltage", 230) < 210        # weak supply (on but low)
                 or h.get("max_voltage", 0) > 250           # overvoltage
                 or h.get("max_power", 0) > 6000]           # extreme load spike
    return {
        "peak_power":          round(max(powers), 2) if powers else 0,
        "avg_power":           round(sum(powers) / len(powers), 2) if powers else 0,
        "min_voltage":         round(min(voltages), 2) if voltages else 0,
        "max_voltage":         round(max(voltages), 2) if voltages else 0,
        "total_energy_today":  round(energy, 4),
        "anomaly_hours":       len(anomalies),
        "hours_recorded":      len(hourly),
    }

# ============================================================
#  OUTAGE LOGGING — Persistent per user
# ============================================================
@app.post("/device/outage", tags=["Outage"])
def log_outage(data: OutagePayload, request: Request):
    """
    Records a power outage.
    Called by:
      - ESP32 on power restore (no auth header) — looks up owner from device
      - Frontend when it detects device went offline (Authorization: Bearer token)
    """
    print(f"log_outage called: device={data.device_id} start={data.start_ts} end={data.end_ts} dur={data.duration}")
    try:
        db = get_db()

        # Try Firebase token from Authorization header (frontend call)
        uid = None
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            try:
                import firebase_admin.auth as fb_auth
                decoded = fb_auth.verify_id_token(auth_header[7:])
                uid = decoded.get("uid")
            except Exception as token_err:
                print(f"Token decode failed (falling back to owner lookup): {token_err}")
                uid = None

        # Fall back to device owner lookup (ESP32 call — no auth header)
        if not uid:
            uid = db.child("devices").child(data.device_id).child("owner").get()

        if not uid:
            raise HTTPException(status_code=404, detail="Device not registered")

    except HTTPException:
        raise
    except Exception as e:
        print(f"log_outage ERROR: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    # Cast to int — avoids Firebase / JSON type errors
    duration = int(data.duration or 0)
    start_ts = int(data.start_ts or 0)
    end_ts   = int(data.end_ts   or 0)

    record = {
        "device_id":    str(data.device_id),
        "start_ts":     start_ts,
        "end_ts":       end_ts,
        "duration":     duration,
        "duration_min": round(duration / 60, 2),
        "start_human":  ts_to_ist(start_ts).strftime("%d %b %Y, %I:%M %p IST") if start_ts > 0 else "unknown",
        "end_human":    ts_to_ist(end_ts).strftime("%d %b %Y, %I:%M %p IST")   if end_ts   > 0 else "unknown",
        "logged_at":    int(time.time()),
        "source":       "frontend",
    }

    db.child("devices").child(data.device_id).child("outages").push(record)
    db.child("users").child(uid).child("outages").push(record)

    stats_ref = db.child("users").child(uid).child("outage_stats")
    existing  = stats_ref.get() or {}
    stats_ref.set({
        "total_outages":      existing.get("total_outages", 0) + 1,
        "total_duration_sec": existing.get("total_duration_sec", 0) + duration,
        "longest_sec":        max(existing.get("longest_sec", 0), duration),
        "last_outage_ts":     start_ts,
        "last_restored_ts":   end_ts,
    })

    print(f"Outage saved: device={data.device_id} uid={uid} dur={duration}s")
    return {"status": "ok", "duration_min": record["duration_min"]}

@app.get("/outages", tags=["Outage"])
def get_outages(uid=Depends(verify_user), limit: int = Query(default=50, le=200)):
    db = get_db()
    raw = db.child("users").child(uid).child("outages").get() or {}
    if not raw:
        return []
    outages = sorted(raw.values(), key=lambda x: x.get("start_ts", 0), reverse=True)
    return outages[:limit]

@app.get("/outages/stats", tags=["Outage"])
def outage_stats(uid=Depends(verify_user)):
    db = get_db()
    stats = db.child("users").child(uid).child("outage_stats").get() or {}
    total = stats.get("total_outages", 0)
    total_sec = stats.get("total_duration_sec", 0)
    return {
        "total_outages":      total,
        "total_downtime_min": round(total_sec / 60, 2),
        "longest_min":        round(stats.get("longest_sec", 0) / 60, 2),
        "avg_duration_min":   round((total_sec / total / 60), 2) if total > 0 else 0,
        "last_outage_ts":     stats.get("last_outage_ts", 0),
        "last_restored_ts":   stats.get("last_restored_ts", 0),
    }

# ============================================================
#  BILLING — Fully persistent, all records in Firebase
# ============================================================
@app.post("/billing/take-reading", tags=["Billing"])
def take_reading(uid=Depends(verify_user)):
    db = get_db()
    device_id = db.child("users").child(uid).child("device_id").get()
    if not device_id:
        raise HTTPException(status_code=400, detail="No device registered")

    live = db.child("devices").child(device_id).child("live").get()
    if not live:
        raise HTTPException(status_code=404, detail="No live data — check device is online")

    energy_now = live.get("energy_kWh", 0)
    ts_now     = live.get("timestamp", int(time.time()))
    dt_now     = ts_to_ist(ts_now)

    bills_ref  = db.child("users").child(uid).child("bills")
    bills      = bills_ref.get() or {}

    if not bills:
        bills_ref.push({
            "energy_start": energy_now,
            "energy_end":   energy_now,
            "from_ts":      ts_now,
            "to_ts":        ts_now,
            "from_date":    dt_now.strftime("%Y-%m-%d %H:%M"),
            "to_date":      dt_now.strftime("%Y-%m-%d %H:%M"),
            "units":        0,
            "energy_charge":0,
            "fixed_charge": 45.0,
            "duty":         0,
            "total":        45.0,
            "slab":         "Slab 1 — Free",
            "type":         "baseline",
        })
        return {"message": "Baseline reading recorded. Next reading will calculate bill.", "units": 0, "total": 45.0}

    bill_list  = sorted(bills.values(), key=lambda x: x.get("to_ts", 0))
    last_bill  = bill_list[-1]
    energy_prev = last_bill.get("energy_end", 0)
    from_ts     = last_bill.get("to_ts", ts_now)
    dt_from     = ts_to_ist(from_ts)

    units         = round(max(0, energy_now - energy_prev), 5)
    energy_charge = calculate_bill(units)
    fixed         = get_fixed_charge(units)
    duty          = round(energy_charge * 0.15, 2)
    total         = round(energy_charge + fixed + duty, 2)

    bills_ref.push({
        "energy_start":  energy_prev,
        "energy_end":    energy_now,
        "from_ts":       from_ts,
        "to_ts":         ts_now,
        "from_date":     dt_from.strftime("%Y-%m-%d %H:%M"),
        "to_date":       dt_now.strftime("%Y-%m-%d %H:%M"),
        "units":         units,
        "energy_charge": energy_charge,
        "fixed_charge":  fixed,
        "duty":          duty,
        "total":         total,
        "slab":          get_slab_label(units),
        "type":          "reading",
    })

    return {
        "units":         units,
        "energy_charge": energy_charge,
        "fixed_charge":  fixed,
        "duty":          duty,
        "total":         total,
        "slab":          get_slab_label(units),
        "from_date":     dt_from.strftime("%Y-%m-%d"),
        "to_date":       dt_now.strftime("%Y-%m-%d"),
    }

@app.get("/billing/history", tags=["Billing"])
def billing_history(uid=Depends(verify_user)):
    db = get_db()
    raw = db.child("users").child(uid).child("bills").get() or {}
    if not raw:
        return []
    bills = sorted(raw.values(), key=lambda x: x.get("to_ts", 0), reverse=True)
    return bills

@app.get("/billing/summary", tags=["Billing"])
def billing_summary(uid=Depends(verify_user)):
    """Lifetime billing stats for the account summary page."""
    db = get_db()
    raw = db.child("users").child(uid).child("bills").get() or {}
    if not raw:
        return {"total_paid": 0, "total_units": 0, "bill_count": 0, "avg_monthly_bill": 0}
    bills = [b for b in raw.values() if b.get("type") != "baseline"]
    if not bills:
        return {"total_paid": 0, "total_units": 0, "bill_count": 0, "avg_monthly_bill": 0}
    total_paid  = sum(b.get("total", 0) for b in bills)
    total_units = sum(b.get("units", 0) for b in bills)
    return {
        "total_paid":       round(total_paid, 2),
        "total_units":      round(total_units, 3),
        "bill_count":       len(bills),
        "avg_monthly_bill": round(total_paid / len(bills), 2),
        "highest_bill":     round(max(b.get("total", 0) for b in bills), 2),
        "lowest_bill":      round(min(b.get("total", 0) for b in bills if b.get("total", 0) > 0), 2) if any(b.get("total", 0) > 0 for b in bills) else 0,
    }

# ============================================================
#  ML — 1. ENERGY COST CALCULATOR (Billing Predictor)
# ============================================================
@app.get("/ml/energy-cost", tags=["ML"])
def get_energy_cost(uid=Depends(verify_user), period: str = Query(default="monthly")):
    """Model 1: Billing Cost Predictor using XGBoost"""
    model_path = "models/cost_predictor.pkl"
    multiplier = 2 if period == "bimonthly" else 1
    
    # 1. Get recent hourly data to build features
    hourly = stats_hourly(uid=uid, days=30 * multiplier)
    if not hourly:
        return {"error": "No hourly data available for cost prediction.", "status": 400}
        
    start_dt = now_ist() - timedelta(days=30 * multiplier)
    start_str = start_dt.strftime("%Y-%m-%d")
    
    cycle_kwh = sum(h.get("energy_kwh", 0) for h in hourly if h["hour"] >= start_str)
    
    # Calculate days elapsed realistically
    days_in_cycle = 30.0 * multiplier
    _days_elapsed = min(days_in_cycle, len(hourly) / 24.0)
    if _days_elapsed == 0: _days_elapsed = 0.1
    
    velocity = cycle_kwh / _days_elapsed
    dow = now_ist().weekday()
    
    predicted_kwh = cycle_kwh
    source = "fallback"
    
    if os.path.exists(model_path):
        try:
            saved = joblib.load(model_path)
            model = saved["model"]
            # Features: ['cumulative_kwh', 'days_elapsed', 'velocity', 'dow']
            X = np.array([[cycle_kwh, _days_elapsed, velocity, dow]], dtype=float)
            predicted_kwh = max(cycle_kwh, float(model.predict(X)[0]))
            source = "xgboost_hybrid"
        except Exception as e:
            print("Model load error:", e)
            pass
            
    # Calculate Bill
    energy_charge = calculate_bill(predicted_kwh)
    fixed = get_fixed_charge(predicted_kwh / multiplier) * multiplier
    duty = round(energy_charge * 0.15, 2)
    total = round(energy_charge + fixed + duty, 2)
    
    # Slabs
    slabs = [
        {"range": "0 – 50 units",    "rate": 0.00,  "units": min(predicted_kwh, 50)},
        {"range": "51 – 200 units",  "rate": 4.70,  "units": max(0, min(predicted_kwh, 200) - 50)},
        {"range": "201 – 250 units", "rate": 6.30,  "units": max(0, min(predicted_kwh, 250) - 200)},
        {"range": "251 – 300 units", "rate": 8.40,  "units": max(0, min(predicted_kwh, 300) - 250)},
        {"range": "301 – 400 units", "rate": 9.45,  "units": max(0, min(predicted_kwh, 400) - 300)},
        {"range": "401 – 500 units", "rate": 10.50, "units": max(0, min(predicted_kwh, 500) - 400)},
        {"range": "Above 500 units", "rate": 11.55, "units": max(0, predicted_kwh - 500)},
    ]
    slab_breakdown = [{"slab": s["range"], "rate": f"₹{s['rate']}/unit" if s["rate"]>0 else "Free", "units": round(s["units"],3), "charge": round(s["units"]*s["rate"],2)} for s in slabs if s["units"]>0]

    # Compute savings / extra cost sensitivity analysis
    savings_if_less = round(calculate_bill(predicted_kwh * 0.9) + get_fixed_charge(predicted_kwh * 0.9 / multiplier) * multiplier + round(calculate_bill(predicted_kwh * 0.9) * 0.15, 2), 2)
    extra_if_more   = round(calculate_bill(predicted_kwh * 1.1) + get_fixed_charge(predicted_kwh * 1.1 / multiplier) * multiplier + round(calculate_bill(predicted_kwh * 1.1) * 0.15, 2), 2)

    return {
        "status": "ok",
        "period": period,
        "months": multiplier,
        "kwh_input": round(predicted_kwh, 2),
        "kwh_source": source,
        "kwh_so_far": round(cycle_kwh, 2),
        "days_elapsed": round(_days_elapsed, 1),
        "days_remaining": round(max(0, days_in_cycle - _days_elapsed), 1),
        "ml_predicted_kwh": round(predicted_kwh, 2),
        "prediction_source": source,
        "energy_charge": round(energy_charge, 2),
        "fixed_charge": round(fixed, 2),
        "electricity_duty": duty,
        "total_bill": total,
        "savings_if_10pct_less": round(total - savings_if_less, 2),
        "extra_if_10pct_more":   round(extra_if_more - total, 2),
        "slab_label": get_slab_label(predicted_kwh / multiplier),
        "slab_breakdown": slab_breakdown
    }

# ============================================================
#  ML — 2. NILM via POWER SPIKES
# ============================================================
@app.get("/ml/nilm", tags=["ML"])
def get_nilm(uid=Depends(verify_user), days: int = Query(default=7, ge=1, le=30)):
    """Model 2: NILM via Delta Power Spikes using Random Forest"""
    hourly = stats_hourly(uid=uid, days=days)
    active = [h for h in hourly if h.get("avg_voltage", 0) > 50]
    if not active:
        return {"error": "No active data for NILM.", "status": 400}
        
    model_path = "models/nilm_spike_model.pkl"
    total_kwh = sum(h.get("energy_kwh", 0) for h in active)
    
    appliance_kwh = {"AC/Compressor": 0.0, "Heavy Heating": 0.0, "Normal Load": 0.0}
    
    if os.path.exists(model_path):
        saved = joblib.load(model_path)
        clf = saved["model"]; scaler = saved["scaler"]; labels_map = saved["labels"]
        # Calculate deltas between consecutive hours
        powers = [h["avg_power"] for h in active]
        deltas = [0.0] + [powers[i] - powers[i-1] for i in range(1, len(powers))]
        
        # Predict each hour's label based on its positive spike and absolute power
        for i, h in enumerate(active):
            dp = max(0, deltas[i])  # focus on upwards spikes
            ap = h.get("avg_power", 0)
            X = np.array([[dp, ap]], dtype=float)
            label_idx = clf.predict(scaler.transform(X))[0]
            label_str = labels_map.get(int(label_idx), "Normal Load")
            appliance_kwh[label_str] += h.get("energy_kwh", 0)
    else:
        # Fallback rule-based if model missing
        for h in active:
            p = h.get("max_power", 0)
            if p > 1900: appliance_kwh["Heavy Heating"] += h.get("energy_kwh", 0)
            elif p > 1100: appliance_kwh["AC/Compressor"] += h.get("energy_kwh", 0)
            else: appliance_kwh["Normal Load"] += h.get("energy_kwh", 0)
            
    # Format out
    out = []
    icons = {"AC/Compressor": "❄️", "Heavy Heating": "🔥", "Normal Load": "💡"}
    colors = {"AC/Compressor": "#38bdf8", "Heavy Heating": "#f87171", "Normal Load": "#10b981"}
    
    for name, kwh in appliance_kwh.items():
        daily = round(kwh / max(1, days), 3)
        pct = round((kwh / max(total_kwh, 0.001)) * 100, 1)
        out.append({
            "name": name,
            "icon": icons.get(name, "🔌"),
            "color": colors.get(name, "#a78bfa"),
            "estimated_daily_kwh": daily,
            "estimated_monthly_kwh": round(daily * 30, 2),
            "percent_share": pct
        })
        
    out = sorted(out, key=lambda x: x["percent_share"], reverse=True)
    hours_analyzed = len(active)
    avg_watts = round(sum(h.get("avg_power", 0) for h in active) / max(1, hours_analyzed), 1)
    return {
        "status": "ok",
        "days_analyzed": days,
        "hours_analyzed": hours_analyzed,
        "total_measured_kwh": round(total_kwh, 2),
        "avg_measured_watts": avg_watts,
        "avg_daily_kwh": round(total_kwh / max(1, days), 3),
        "appliances": out,
        "note": "AI Pattern Matcher: Analyzed via sudden wattage spikes (Delta Power)."
    }

# ============================================================
#  ML — 3. VOLTAGE FLUCTUATION PROBABILITY (Instantaneous)
# ============================================================
from scipy.stats import norm

@app.get("/ml/voltage-fluctuation", tags=["ML"])
def get_voltage_fluctuation(uid=Depends(verify_user), days: int = Query(default=14, ge=1, le=30)):
    """
    Model 3: Voltage Stability Index (VSI) + Fluctuation Prediction.
    Instantaneously trains on the user's localized grid data.
    VSI = 1 - (spread / safe_band_width), clamped to [0, 1].
    """
    hourly = stats_hourly(uid=uid, days=days)
    active = [h for h in hourly if h.get("avg_voltage", 0) > 50]
    if len(active) < 12:
        return {"error": "Need at least 12 hours of data to analyse voltage stability.", "status": 400}

    SAFE_LOW, SAFE_HIGH = 210.0, 250.0
    SAFE_BAND = SAFE_HIGH - SAFE_LOW  # 40V

    history = []
    flagged_events = []

    for h in active:
        min_v = h.get("min_voltage", 230)
        max_v = h.get("max_voltage", 230)
        avg_v = h.get("avg_voltage", 230)
        spread = max_v - min_v

        vsi = round(max(0.0, min(1.0, 1.0 - spread / SAFE_BAND)), 3)

        if min_v < SAFE_LOW or max_v > SAFE_HIGH or spread > 20:
            status = "SEVERE_FLUCTUATION"
        elif spread > 10 or min_v < 215:
            status = "MILD_FLUCTUATION"
        else:
            status = "STABLE"

        advice = []
        if min_v < 200:
            advice.append("Disconnect sensitive electronics")
        elif min_v < 215:
            advice.append("Use voltage stabiliser")
        if max_v > 255:
            advice.append("Risk of appliance burnout")
        if spread > 25:
            advice.append("Log TNEB complaint")

        entry = {
            "hour": h["hour"],
            "hour_label": f"{h['hour_num'] % 12 or 12}{'am' if h['hour_num'] < 12 else 'pm'}",
            "min_v": round(min_v, 1),
            "max_v": round(max_v, 1),
            "avg_v": round(avg_v, 1),
            "spread": round(spread, 1),
            "vsi": vsi,
            "status": status,
            "advice": advice,
        }
        history.append(entry)
        if status != "STABLE":
            flagged_events.append(entry)

    # Summary stats
    total_h = len(history)
    stable   = sum(1 for h in history if h["status"] == "STABLE")
    mild     = sum(1 for h in history if h["status"] == "MILD_FLUCTUATION")
    severe   = sum(1 for h in history if h["status"] == "SEVERE_FLUCTUATION")
    stable_pct = round(stable / max(1, total_h) * 100, 1)

    overall_vsi = round(np.mean([h["vsi"] for h in history]), 3) if history else 0.0

    # Trend: compare first half vs second half VSI
    mid = len(history) // 2
    vsi_first = np.mean([h["vsi"] for h in history[:mid]]) if mid > 0 else 0.5
    vsi_second = np.mean([h["vsi"] for h in history[mid:]]) if history[mid:] else 0.5
    if vsi_second > vsi_first + 0.03:
        stability_trend = "improving"
    elif vsi_second < vsi_first - 0.03:
        stability_trend = "worsening"
    else:
        stability_trend = "stable"

    # Alert level
    if overall_vsi >= 0.80:
        alert_level, alert_emoji, alert_message = "GREEN", "✅", "Grid is stable. Your appliances are safe."
    elif overall_vsi >= 0.60:
        alert_level, alert_emoji, alert_message = "YELLOW", "⚠️", "Mild fluctuations detected. Consider a stabiliser for sensitive devices."
    else:
        alert_level, alert_emoji, alert_message = "RED", "🚨", "Severe voltage instability. Disconnect ACs, TVs, and computers during peak hours."

    # Sort flagged events by severity
    flagged_events = sorted(flagged_events, key=lambda x: x["vsi"])

    return {
        "status": "ok",
        "days_analyzed": days,
        "hours_analyzed": total_h,
        "overall_vsi": overall_vsi,
        "alert_level": alert_level,
        "alert_emoji": alert_emoji,
        "alert_message": alert_message,
        "stability_trend": stability_trend,
        "summary": {
            "stable_hours": stable,
            "mild_hours": mild,
            "severe_hours": severe,
            "stable_pct": stable_pct,
        },
        "flagged_events": flagged_events[:10],
        "history": history[-48:],  # last 48 hours for the chart
        "note": "Instantaneous VSI — trained on your local grid history."
    }
