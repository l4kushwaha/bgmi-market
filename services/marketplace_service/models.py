from database import db
from datetime import datetime

class BGMI_ID(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    seller_id = db.Column(db.Integer, nullable=False)
    uid = db.Column(db.String(50), unique=True, nullable=False)
    rank = db.Column(db.String(50))
    mythic_count = db.Column(db.Integer, default=0)
    legendary_count = db.Column(db.Integer, default=0)
    x_suit_count = db.Column(db.Integer, default=0)
    price = db.Column(db.Float, nullable=False)
    status = db.Column(db.String(20), default="available")  # available, sold, pending
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

