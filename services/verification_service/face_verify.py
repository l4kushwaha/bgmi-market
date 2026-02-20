from flask import Blueprint, request, jsonify
from database import db
from models import Verification
import random

face_bp = Blueprint('face_bp', __name__)

@face_bp.route('/verify/face', methods=['POST'])
def verify_face():
    """
    Simulate face verification between two images.
    Example JSON:
    {
        "user_id": 12,
        "image_1": "base64_image_string_1",
        "image_2": "base64_image_string_2"
    }
    """
    data = request.get_json()
    user_id = data.get("user_id")
    img1 = data.get("image_1")
    img2 = data.get("image_2")

    if not user_id or not img1 or not img2:
        return jsonify({"error": "Missing required fields"}), 400

    # Simulated similarity score
    similarity = round(random.uniform(70, 99), 2)
    status = "success" if similarity > 80 else "failed"

    verification = Verification(
        user_id=user_id,
        verification_type="face",
        status=status,
        confidence=similarity,
        remarks="Face match confirmed" if status == "success" else "Face mismatch"
    )

    db.session.add(verification)
    db.session.commit()

    return jsonify({
        "message": "Face verification complete",
        "status": status,
        "confidence": similarity
    }), 200

