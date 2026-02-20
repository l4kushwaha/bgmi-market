
from datetime import datetime
from database import db

class ModuleStatus(db.Model):
    __tablename__ = 'module_status'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)
    status = db.Column(db.String(20), nullable=False, default='running')  # running, maintenance, down
    updated_at = db.Column(db.DateTime, default=datetime.utcnow)

class CommissionRecord(db.Model):
    __tablename__ = 'commission_records'
    id = db.Column(db.Integer, primary_key=True)
    listing_id = db.Column(db.Integer, nullable=True)
    seller_id = db.Column(db.Integer, nullable=True)
    amount = db.Column(db.Float, nullable=False)  # commission amount
    currency = db.Column(db.String(10), default='INR')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class UserReport(db.Model):
    __tablename__ = 'user_reports'
    id = db.Column(db.Integer, primary_key=True)
    reporter_id = db.Column(db.Integer, nullable=False)
    reported_user_id = db.Column(db.Integer, nullable=True)
    listing_id = db.Column(db.Integer, nullable=True)
    reason = db.Column(db.String(500))
    status = db.Column(db.String(20), default='open')  # open, in_review, resolved
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
