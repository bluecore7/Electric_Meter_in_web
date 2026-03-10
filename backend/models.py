# models.py — EnergyFlow v3.0 data models

from pydantic import BaseModel
from typing import Optional

class DevicePayload(BaseModel):
    device_id:  str
    voltage:    float
    current:    float = 0.0
    power:      float
    energy_kWh: float
    timestamp:  int

class OutagePayload(BaseModel):
    device_id: str
    start_ts:  int
    end_ts:    int
    duration:  int

class UserProfile(BaseModel):
    display_name:    Optional[str] = None
    phone:           Optional[str] = None
    address:         Optional[str] = None
    eb_consumer_no:  Optional[str] = None
    tariff_type:     Optional[str] = None
    sanctioned_load: Optional[float] = None