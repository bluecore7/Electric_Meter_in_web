# firebase.py
import os
import json
import base64
import firebase_admin
from firebase_admin import credentials, db

def init_firebase():
    if firebase_admin._apps:
        return

    key_base64 = os.environ.get("FIREBASE_KEY_BASE64")
    if not key_base64:
        raise RuntimeError("FIREBASE_KEY_BASE64 not set")

    cred_dict = json.loads(
        base64.b64decode(key_base64).decode("utf-8")
    )

    cred = credentials.Certificate(cred_dict)

    firebase_admin.initialize_app(
        cred,
        {
            "databaseURL": "https://energyflow-esp32-default-rtdb.firebaseio.com"
        }
    )

def get_db():
    init_firebase()
    return db.reference("/")
