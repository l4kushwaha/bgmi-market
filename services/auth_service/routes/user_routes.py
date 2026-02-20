# auth_service/routes/user_routes.py
from flask import Blueprint, request, jsonify
from utils import verify_token
from models import User

user_bp = Blueprint('user_bp', __name__)

@user_bp.route('/me', methods=['GET'])
def profile():
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return jsonify({"error": "Token missing"}), 401

    token = auth_header.split(" ")[1]
    user_id = verify_token(token)
    if not user_id:
        return jsonify({"error": "Invalid or expired token"}), 401

    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    return jsonify({
        "id": user.id,
        "name": user.full_name,
        "email": user.email,
        "verified": user.verified
    }), 200
