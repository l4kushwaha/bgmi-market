# auth_service/utils.py
import jwt
import bcrypt
import datetime
from flask import current_app

# ==========================
# 🔐 Password Hash Utilities
# ==========================
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def check_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))


# ==========================
# 🎟️ Token Utilities
# ==========================
def generate_token(user_payload):
    """
    user_payload: dict -> {
        "id": <int or 0>,
        "email": <str>,
        "role": "user" or "admin"
    }
    """
    payload = {
        "user_id": user_payload.get("id"),
        "email": user_payload.get("email"),
        "role": user_payload.get("role", "user"),
        "exp": datetime.datetime.utcnow() + datetime.timedelta(days=3),
        "iat": datetime.datetime.utcnow()
    }

    token = jwt.encode(payload, current_app.config['SECRET_KEY'], algorithm="HS256")
    return token


def verify_token(token):
    """
    Verifies and decodes JWT token.
    Returns user_id (int) if valid, otherwise None.
    """
    try:
        data = jwt.decode(token, current_app.config['SECRET_KEY'], algorithms=["HS256"])
        return data.get("user_id")
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None
