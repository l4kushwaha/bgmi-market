# auth_service/routes/kyc_routes.py
import os
import requests
from flask import Blueprint, request, jsonify, current_app
from models import User, db
from utils import verify_token

kyc_bp = Blueprint('kyc_bp', __name__)

UPLOAD_FOLDER = "static/uploads/"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

@kyc_bp.route('/upload', methods=['POST'])
def upload_kyc():
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return jsonify({"error": "Missing token"}), 401

    token = auth_header.split(" ")[1]
    user_id = verify_token(token)
    if not user_id:
        return jsonify({"error": "Invalid or expired token"}), 401

    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    aadhaar = request.files.get("aadhaar")
    pan = request.files.get("pan")
    selfie = request.files.get("selfie")

    if not all([aadhaar, pan, selfie]):
        return jsonify({"error": "All three documents (aadhaar, pan, selfie) required"}), 400

    aadhaar_path = os.path.join(UPLOAD_FOLDER, f"{user_id}_aadhaar.jpg")
    pan_path = os.path.join(UPLOAD_FOLDER, f"{user_id}_pan.jpg")
    selfie_path = os.path.join(UPLOAD_FOLDER, f"{user_id}_selfie.jpg")

    aadhaar.save(aadhaar_path)
    pan.save(pan_path)
    selfie.save(selfie_path)

    verify_url = current_app.config.get("VERIFICATION_URL", "http://localhost:5004/verify/kyc")
    payload = {"user_id": user_id}
    files = {
        'aadhaar': open(aadhaar_path, 'rb'),
        'pan': open(pan_path, 'rb'),
        'selfie': open(selfie_path, 'rb')
    }

    try:
        response = requests.post(verify_url, files=files, data=payload)
        result = response.json()
    except Exception as e:
        return jsonify({"error": "Verification service not reachable", "details": str(e)}), 500
    finally:
        for f in files.values():
            f.close()

    if result.get("verified"):
        user.verified = True
        db.session.commit()
        return jsonify({"message": "KYC verified successfully"}), 200
    else:
        return jsonify({"message": "KYC verification failed"}), 400
