import os
import base64
import json
import firebase_admin
from firebase_admin import credentials, db

key_base64 = os.environ.get("FIREBASE_KEY_BASE64")
if not key_base64:
    raise RuntimeError("FIREBASE_KEY_BASE64 not set")

cred_dict = json.loads(base64.b64decode(key_base64).decode())

if not firebase_admin._apps:
    firebase_admin.initialize_app(
        credentials.Certificate(cred_dict),
        {"databaseURL": "https://energyflow-esp32-default-rtdb.firebaseio.com"}
    )

def get_db():
    return db.reference("/")
