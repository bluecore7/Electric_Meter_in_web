# models.py — Pydantic models for EnergyFlow API

from pydantic import BaseModel
from typing import Optional

class DevicePayload(BaseModel):
    """
    Payload sent by ESP32 every 3 seconds.
    Fields:
      device_id   : Unique device identifier (e.g. "ESP001")
      voltage     : AC voltage in Volts (V)
      current     : AC current in Amperes (A)  ← NEW
      power       : Apparent/active power in Watts (W)
      energy_kWh  : Cumulative energy since last reset (kWh)
      timestamp   : Unix epoch seconds (UTC)
    """
    device_id:  str
    voltage:    float
    current:    float = 0.0   # Optional for backward compatibility
    power:      float
    energy_kWh: float
    timestamp:  int
