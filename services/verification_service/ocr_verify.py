
from flask import Blueprint, request, jsonify
from database import db
from models import Verification
import random

orc_bp = Blueprint('orc_bp', __name__)

@orc_bp.route('/verify/ocr', methods=['POST'])
def verify_ocr():
    """
    Simulate OCR verification by checking if provided text contains keywords.
    Example JSON:
    {
        "user_id": 12,
        "document_text": "Driving License No. XYZ1234"
    }
    """
    data = request.get_json()
    user_id = data.get("user_id")
    document_text = data.get("document_text", "")

    if not user_id or not document_text:
        return jsonify({"error": "Missing user_id or document_text"}), 400

    # Simulate OCR validation
    keywords = ["License", "ID", "Passport", "Card", "Government"]
    success = any(word.lower() in document_text.lower() for word in keywords)

    status = "success" if success else "failed"
    confidence = round(random.uniform(80, 99), 2) if success else round(random.uniform(40, 60), 2)

    verification = Verification(
        user_id=user_id,
        verification_type="ocr",
        status=status,
        confidence=confidence,
        remarks="Document appears valid" if success else "Document not recognized"
    )
    db.session.add(verification)
    db.session.commit()

    return jsonify({
        "message": "OCR verification complete",
        "status": status,
        "confidence": confidence
    }), 200
