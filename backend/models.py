# models.py
from pydantic import BaseModel

class DevicePayload(BaseModel):
    device_id: str
    voltage: float
    power: float
    energy_kWh: float
    timestamp: int
