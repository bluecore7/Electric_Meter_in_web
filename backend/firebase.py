# firebase.py
import os
import base64
import json
import firebase_admin
from firebase_admin import credentials, db

# Decode base64 key from env
key_base64 = os.environ.get("FIREBASE_KEY_BASE64")
if not key_base64:
    raise RuntimeError("FIREBASE_KEY_BASE64 not set")

key_json = base64.b64decode(key_base64).decode("utf-8")
cred_dict = json.loads(key_json)

cred = credentials.Certificate(cred_dict)

firebase_admin.initialize_app(cred, {
    "databaseURL": "https://energyflow-esp32-default-rtdb.firebaseio.com"
})

def get_db():
    return db.reference("/")
