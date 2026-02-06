# auth.py
from fastapi import Header, HTTPException
import firebase_admin
from firebase_admin import auth

def verify_user(authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid token")

    token = authorization.split(" ")[1]

    try:
        decoded = auth.verify_id_token(token)
        return decoded["uid"]
    except:
        raise HTTPException(status_code=401, detail="Invalid Firebase token")