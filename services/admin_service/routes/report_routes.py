
from flask import Blueprint, request, jsonify
from models import UserReport
from database import db

report_bp = Blueprint('report_bp', __name__)

@report_bp.route('/report', methods=['POST'])
def create_report():
    data = request.get_json()
    r = UserReport(
        reporter_id = data.get('reporter_id'),
        reported_user_id = data.get('reported_user_id'),
        listing_id = data.get('listing_id'),
        reason = data.get('reason')
    )
    db.session.add(r)
    db.session.commit()
    return jsonify({"message":"report created","report_id": r.id}), 201

@report_bp.route('/reports', methods=['GET'])
def list_reports():
    rs = UserReport.query.order_by(UserReport.created_at.desc()).all()
    return jsonify([{
        "id": r.id,
        "reporter_id": r.reporter_id,
        "reported_user_id": r.reported_user_id,
        "listing_id": r.listing_id,
        "reason": r.reason,
        "status": r.status,
        "created_at": r.created_at
    } for r in rs])
    
@report_bp.route('/report/<int:rid>/resolve', methods=['POST'])
def resolve_report(rid):
    r = UserReport.query.get(rid)
    if not r:
        return jsonify({"error":"not found"}),404
    r.status = 'resolved'
    db.session.commit()
    return jsonify({"message":"resolved"})
