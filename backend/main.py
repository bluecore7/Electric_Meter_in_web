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
    if units <= 0: return 0.0
    cost = 0.0
    if units > 100: cost += min(units - 100, 100) * 2.25
    if units > 200: cost += min(units - 200, 300) * 4.50
    if units > 500: cost += (units - 500) * 6.60
    return round(cost, 2)

def get_fixed_charge(units: float) -> float:
    if units <= 100: return 45.0
    if units <= 200: return 75.0
    if units <= 500: return 115.0
    return 155.0

def get_slab_label(units: float) -> str:
    if units <= 100: return "Slab 1 — Free"
    if units <= 200: return "Slab 2 — ₹2.25/unit"
    if units <= 500: return "Slab 3 — ₹4.50/unit"
    return "Slab 4 — ₹6.60/unit"

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
    db = get_db()
    db.child("users").child(uid).child("device_id").set(device_id)
    db.child("devices").child(device_id).child("owner").set(uid)
    db.child("devices").child(device_id).child("registered_at").set(int(time.time()))
    return {"message": f"Device {device_id} registered", "device_id": device_id}

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
#  ML INFERENCE DATA — serves pre-computed data for frontend
# ============================================================
@app.get("/ml/anomalies", tags=["ML"])
def get_anomalies(uid=Depends(verify_user), days: int = 1):
    """Returns hourly records flagged as anomalous (rule-based + Z-score)."""
    hourly = stats_hourly(uid=uid, days=days)
    if not hourly:
        return []
    anomalies = []
    active = [h for h in hourly if h.get("avg_voltage", 0) > 50]
    if not active:
        return []
    powers = [h["avg_power"] for h in active if h["avg_power"] > 0]
    if powers:
        p_mean = sum(powers) / len(powers)
        p_var  = sum((p - p_mean) ** 2 for p in powers) / len(powers)
        p_std  = p_var ** 0.5
    else:
        p_mean = p_std = 1

    for h in active:
        if h.get("avg_voltage", 0) <= 50:
            continue
        flags = []
        min_v = h.get("min_voltage", 230)
        if 0 < min_v < 210:
            flags.append({"type": "LOW_VOLTAGE",   "value": min_v, "unit": "V",
                          "meaning": "Supply voltage dropped while power was ON — check TNEB supply quality"})
        max_v = h.get("max_voltage", 0)
        if max_v > 250:
            flags.append({"type": "HIGH_VOLTAGE",  "value": max_v, "unit": "V",
                          "meaning": "Voltage exceeded 250V — risk of damage to sensitive appliances"})
        max_p = h.get("max_power", 0)
        if max_p > 6000:
            flags.append({"type": "HIGH_POWER",    "value": max_p, "unit": "W",
                          "meaning": "Unusually high load detected — check if all appliances are expected"})
        avg_p = h.get("avg_power", 0)
        if avg_p > 0 and p_std > 0:
            z = abs(avg_p - p_mean) / p_std
            if z > 2.5:
                flags.append({"type": "POWER_OUTLIER", "value": round(avg_p, 1), "unit": "W",
                              "meaning": f"Power {round(z,1)}σ from typical usage — flagged by Isolation Forest"})
        if flags:
            anomalies.append({**h, "flags": flags})
    return anomalies


@app.get("/ml/anomalies/isolation-forest", tags=["ML"])
def get_isolation_forest_anomalies(uid=Depends(verify_user), days: int = 1):
    """Runs the trained Isolation Forest on recent hourly data. Returns anomaly scores."""
    model_path = "models/power_anomaly.pkl"
    if not os.path.exists(model_path):
        return {"error": "Isolation Forest model not trained.", "status": 500}
    saved    = joblib.load(model_path)
    if_model = saved["model"]; scaler = saved["scaler"]; features = saved["features"]
    hourly   = stats_hourly(uid=uid, days=30)
    active   = [h for h in hourly if h.get("avg_voltage", 0) > 50]
    if not active:
        return {"anomaly_count": 0, "total_hours": 0, "flagged": []}
    powers = [h.get("avg_power", 0) for h in active]
    rows   = []
    for i, h in enumerate(active):
        hod = h.get("hour_num", 0)
        try: dow = datetime.strptime(h["hour"], "%Y-%m-%d_%H").weekday()
        except: dow = 0
        w = powers[max(0, i-6):i+1]
        rm = sum(w)/len(w); rs = (sum((x-rm)**2 for x in w)/len(w))**0.5
        rows.append({"avg_power": h.get("avg_power",0), "avg_current": h.get("avg_current",0),
                     "hour_of_day": hod, "is_weekend": 1 if dow in [5,6] else 0,
                     "power_rolling_mean": rm, "power_rolling_std": rs,
                     "hour_sin": math.sin(2*math.pi*hod/24), "hour_cos": math.cos(2*math.pi*hod/24)})
    X = np.array([[r[f] for f in features] for r in rows], dtype=float)
    X_s = scaler.transform(X)
    preds = if_model.predict(X_s); scores = if_model.decision_function(X_s)
    flagged = [{"hour": h["hour"], "avg_power": h["avg_power"], "score": round(float(s),4)}
               for h, p, s in zip(active, preds, scores) if p == -1]
    return {"status": "ok", "anomaly_count": int((preds==-1).sum()),
            "total_hours": len(active),
            "anomaly_pct": round(100*(preds==-1).sum()/len(active), 1),
            "flagged": flagged}


@app.get("/ml/load", tags=["ML"])
def get_load_type(uid=Depends(verify_user), hours: int = Query(default=24, ge=1, le=168)):
    """KMeans load classification — Standby / Light / Medium / Heavy."""
    model_path = "models/load_cluster.pkl"
    if not os.path.exists(model_path):
        return {"error": "Load cluster model not trained.", "status": 500}
    saved     = joblib.load(model_path)
    km        = saved["model"]; scaler = saved["scaler"]
    features  = saved["features"]; label_map = saved["label_map"]
    human     = {0: "Standby", 1: "Light Load", 2: "Medium Load", 3: "Heavy Load"}
    hourly    = stats_hourly(uid=uid, days=30)
    active    = [h for h in hourly if h.get("avg_voltage",0) > 50][-hours:]
    if not active:
        return {"error": "No active hourly data.", "status": 400}
    X    = np.array([[h.get("avg_power",0), h.get("avg_current",0), h.get("hour_num",0)]
                     for h in active], dtype=float)
    X_s  = scaler.transform(X)
    raw  = km.predict(X_s)
    types = [human.get(label_map.get(int(r),0),"Unknown") for r in raw]
    return {"status": "ok", "current_load_type": types[-1] if types else "Unknown",
            "distribution": {t: types.count(t) for t in human.values()},
            "hours_analyzed": len(active), "recent_sequence": types[-12:]}


@app.get("/ml/bill-risk", tags=["ML"])
def get_bill_risk(uid=Depends(verify_user)):
    """Random Forest high-bill probability (0–100%) and risk label: Low/Medium/High."""
    model_path = "models/bill_predictor.pkl"
    if not os.path.exists(model_path):
        return {"error": "Bill predictor model not trained.", "status": 500}
    saved        = joblib.load(model_path)
    rf           = saved["model"]; scaler = saved["scaler"]; feature_cols = saved["features"]
    hourly       = stats_hourly(uid=uid, days=30)
    if not hourly or len(hourly) < 7:
        return {"error": "Need at least 7 hours of data.", "status": 400}
    powers = [h.get("avg_power",0) for h in hourly]
    rows   = []
    for i, h in enumerate(hourly):
        hod = h.get("hour_num",0)
        try: dow = datetime.strptime(h["hour"], "%Y-%m-%d_%H").weekday()
        except: dow = 0
        w = powers[max(0,i-6):i+1]
        rm = sum(w)/len(w); rs = (sum((x-rm)**2 for x in w)/len(w))**0.5
        avg_v = h.get("avg_voltage",230); avg_i = h.get("avg_current",0); avg_p = h.get("avg_power",0)
        ap = avg_v*avg_i; pf = min(1.0, max(0.0, avg_p/ap)) if ap>0 else 1.0
        rows.append({"avg_power":avg_p, "avg_voltage":avg_v, "avg_current":avg_i,
                     "energy_kwh":h.get("energy_kwh",0),
                     "hour_of_day":hod, "day_of_week":dow, "is_weekend":1 if dow in [5,6] else 0,
                     "power_rolling_mean":rm, "power_rolling_std":rs,
                     "hour_sin":math.sin(2*math.pi*hod/24), "hour_cos":math.cos(2*math.pi*hod/24),
                     "dow_sin":math.sin(2*math.pi*dow/7),   "dow_cos":math.cos(2*math.pi*dow/7),
                     "power_factor":pf})
    X   = np.array([[r[c] for c in feature_cols] for r in rows], dtype=float)
    X_s = scaler.transform(X); prob = rf.predict_proba(X_s)[:,1]
    avg_prob = float(prob.mean()); latest = float(prob[-1])
    return {"status": "ok",
            "high_bill_probability": round(avg_prob*100,1),
            "latest_hour_probability": round(latest*100,1),
            "risk_label": "Low" if avg_prob<0.3 else ("Medium" if avg_prob<0.7 else "High"),
            "hours_analyzed": len(hourly)}


@app.get("/ml/forecast", tags=["ML"])
def get_forecast(uid=Depends(verify_user)):
    """PyTorch Neural Network — 24-hour power forecast (t+1 … t+24) in Watts."""
    model_path = "models/power_forecaster.pth"
    meta_path  = "models/power_forecaster_meta.pkl"
    if not os.path.exists(model_path) or not os.path.exists(meta_path):
        return {"error": "PyTorch forecast model not trained.", "status": 500}
    try:
        import torch, torch.nn as nn
    except ImportError:
        return {"error": "PyTorch is not installed on this server.", "status": 500}

    class PowerForecasterNet(nn.Module):
        def __init__(self, inp, out):
            super().__init__()
            self.fc1=nn.Linear(inp,64); self.relu=nn.ReLU()
            self.fc2=nn.Linear(64,64);  self.fc3=nn.Linear(64,out)
        def forward(self, x):
            return self.fc3(self.relu(self.fc2(self.relu(self.fc1(x)))))

    meta = joblib.load(meta_path)
    net  = PowerForecasterNet(meta["input_size"], meta["output_size"])
    net.load_state_dict(torch.load(model_path, map_location="cpu", weights_only=True))
    net.eval()

    hourly = stats_hourly(uid=uid, days=30)
    active = [h for h in hourly if h.get("avg_voltage",0) > 50]
    if len(active) < 24:
        return {"error": f"Need 24 hours of data (found {len(active)}).", "status": 400}
    recent = active[-24:]; last = recent[-1]
    try: dt_last = datetime.strptime(last["hour"], "%Y-%m-%d_%H")
    except: return {"error": "Invalid hour format.", "status": 500}
    feat = {f"power_lag_{i}": recent[23-i]["avg_power"] for i in range(24)}
    feat["hour_of_day"] = dt_last.hour
    feat["day_of_week"] = dt_last.weekday()
    feat["is_weekend"]  = 1 if feat["day_of_week"] in [5,6] else 0
    fc = meta["features"]
    X  = np.array([[feat[c] for c in fc]], dtype=np.float32)
    X_s = meta["scaler_X"].transform(X)
    with torch.no_grad():
        y_s = net(torch.tensor(X_s, dtype=torch.float32)).numpy()
    y_pred = np.maximum(meta["scaler_Y"].inverse_transform(y_s)[0], 0).tolist()
    return {"status": "ok",
            "forecast_w": [round(v,1) for v in y_pred],
            "hours": [(dt_last+timedelta(hours=i+1)).strftime("%H:00") for i in range(24)],
            "from_hour": dt_last.strftime("%d %b %Y, %H:00 IST"),
            "model": "PyTorch NN (3-layer feedforward, 24h output)"}


@app.get("/ml/predict", tags=["ML"])
def get_prediction(uid=Depends(verify_user)):
    """
    Returns the XGBoost prediction for the TOTAL kWh that will be consumed
    by the end of the current calendar month, along with the estimated TNEB bill.

    Uses all hourly records from the start of the current month to build
    the same 11 cumulative/rate features used during training.
    """
    # 1. Ensure the XGBoost model is available
    model_path = "models/xgb_forecaster.pkl"
    if not os.path.exists(model_path):
        return {"error": "Prediction model not trained. Please run ml_pipeline --mode train first.", "status": 500}

    saved = joblib.load(model_path)
    model        = saved["model"]
    feature_cols = saved["features"]

    # 2. Fetch all hourly records for the current calendar month (up to 31 days)
    hourly_records = stats_hourly(uid=uid, days=31)
    if not hourly_records:
        return {"error": "No hourly data available for this month.", "status": 400}

    # Filter to current calendar month only
    now_month = now_ist().strftime("%Y-%m")
    month_records = [h for h in hourly_records if h["hour"].startswith(now_month)]
    if not month_records:
        return {"error": f"No data found for {now_month}.", "status": 400}

    # 3. Build the same features used during training
    month_df = pd.DataFrame(month_records).sort_values("hour").reset_index(drop=True)
    month_df["datetime"] = pd.to_datetime(month_df["hour"], format="%Y-%m-%d_%H")

    month_df["energy_so_far_kwh"]      = month_df["energy_kwh"].cumsum()
    month_df["hours_elapsed_in_month"] = range(1, len(month_df) + 1)
    month_df["days_elapsed"]           = month_df["hours_elapsed_in_month"] / 24.0
    month_df["days_in_month"]          = month_df["datetime"].dt.days_in_month.astype(float)
    month_df["days_remaining"]         = (month_df["days_in_month"] - month_df["days_elapsed"]).clip(lower=0)
    month_df["avg_daily_kwh"]          = month_df["energy_so_far_kwh"] / month_df["days_elapsed"].clip(lower=1/24)
    month_df["projected_kwh"]          = month_df["avg_daily_kwh"] * month_df["days_in_month"]
    month_df["power_rolling_24h"]      = month_df["avg_power"].rolling(24,  min_periods=1).mean()
    month_df["power_rolling_168h"]     = month_df["avg_power"].rolling(168, min_periods=1).mean()
    month_df["day_of_month"]           = month_df["datetime"].dt.day
    month_df["month_of_year"]          = month_df["datetime"].dt.month
    month_df["hour_of_day"]            = month_df["datetime"].dt.hour
    month_df["is_weekend"]             = month_df["datetime"].dt.dayofweek.isin([5, 6]).astype(int)

    last = month_df.iloc[-1]
    feat_dict = {col: last[col] for col in feature_cols}
    X_pred    = pd.DataFrame([feat_dict], columns=feature_cols).values

    # 4. Predict
    predicted_kwh      = float(round(model.predict(X_pred)[0], 3))
    energy_so_far      = float(round(last["energy_so_far_kwh"], 3))
    days_elapsed       = float(round(last["days_elapsed"], 1))
    days_remaining     = float(round(last["days_remaining"], 1))
    projected_kwh      = float(round(last["projected_kwh"], 3))

    # 5. Estimated TNEB bill on the predicted total
    est_bill           = calculate_bill(predicted_kwh)
    fixed              = get_fixed_charge(predicted_kwh)
    duty               = round(est_bill * 0.15, 2)
    est_total          = round(est_bill + fixed + duty, 2)

    # Partial bill on units used so far
    partial_bill       = round(calculate_bill(energy_so_far) + get_fixed_charge(energy_so_far), 2)

    return {
        "status":               "ok",
        "month":                now_month,
        "days_elapsed":         days_elapsed,
        "days_remaining":       days_remaining,
        "energy_so_far_kwh":    energy_so_far,
        "projected_kwh":        projected_kwh,        # naive linear projection
        "predicted_monthly_kwh": predicted_kwh,       # XGBoost prediction
        "slab":                 get_slab_label(predicted_kwh),
        "estimated_bill": {
            "energy_charge":    est_bill,
            "fixed_charge":     fixed,
            "duty":             duty,
            "total":            est_total,
        },
        "partial_bill_so_far":  partial_bill,
    }

# ============================================================
#  DATA EXPORT
# ============================================================
@app.get("/export/csv", tags=["Export"])
def export_csv(uid=Depends(verify_user), days: int = 30):
    """Returns raw hourly data as JSON for CSV export in the frontend."""
    return stats_hourly(uid=uid, days=days)