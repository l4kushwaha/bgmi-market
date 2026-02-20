from flask import Blueprint, request, jsonify
from models import User, db
from utils import hash_password, check_password, generate_token

auth_bp = Blueprint('auth_bp', __name__)

# === Admin Configuration ===
ADMIN_EMAIL = "L4kushwaha@gmail.com"
ADMIN_PASSWORD = "ELEGENT1832"
ADMIN_PHONE = "7905584212"
ADMIN_NAME = "Admin"


# ========================
# 🧾 Register Route
# ========================
@auth_bp.route('/register', methods=['POST'])
def register():
    data = request.get_json()

    if not data.get("email") or not data.get("password"):
        return jsonify({"error": "Missing required fields"}), 400

    if User.query.filter_by(email=data['email']).first():
        return jsonify({"error": "Email already registered"}), 400

    new_user = User(
        full_name=data['full_name'],
        email=data['email'],
        password=hash_password(data['password']),
        phone=data.get('phone')
    )

    db.session.add(new_user)
    db.session.commit()
    return jsonify({"message": "User registered successfully"}), 201


# ========================
# 🔐 Login Route (with Admin Support)
# ========================
@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    print("🟡 Login Data Received:", data)  # Debug print

    if not data or not data.get("email") or not data.get("password"):
        return jsonify({"error": "Email and password required"}), 400

    email = data['email'].strip().lower()
    password = data['password'].strip()

    # === Admin Login Check ===
    if email.lower() == ADMIN_EMAIL.lower() and password == ADMIN_PASSWORD:
        print("✅ Admin login successful")
        admin_payload = {
            "id": 0,
            "email": ADMIN_EMAIL,
            "role": "admin"
        }
        token = generate_token(admin_payload)
        return jsonify({
            "message": "Admin login successful",
            "role": "admin",
            "admin_info": {
                "name": ADMIN_NAME,
                "email": ADMIN_EMAIL,
                "phone": ADMIN_PHONE
            },
            "token": token
        }), 200

    # === Normal User Login ===
    user = User.query.filter_by(email=email).first()

    if not user or not check_password(password, user.password):
        print("❌ Invalid user credentials")
        return jsonify({"error": "Invalid credentials"}), 401

    token_payload = {
        "id": user.id,
        "email": user.email,
        "role": "user"
    }
    token = generate_token(token_payload)

    return jsonify({
        "message": "Login successful",
        "role": "user",
        "token": token,
        "user": {
            "id": user.id,
            "name": user.full_name,
            "email": user.email
        }
    }), 200
