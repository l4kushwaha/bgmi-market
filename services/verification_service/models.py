from datetime import datetime
from database import db

class Verification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, nullable=False)
    verification_type = db.Column(db.String(50), nullable=False)  # "face" or "ocr"
    status = db.Column(db.String(20), default="pending")  # pending, success, failed
    confidence = db.Column(db.Float)
    remarks = db.Column(db.String(255))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
