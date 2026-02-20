
from flask import Blueprint, request, jsonify, current_app
from models import CommissionRecord, ModuleStatus
from database import db
from utils.analytics import total_commission, commission_by_day, top_sellers

admin_bp = Blueprint('admin_bp', __name__)

@admin_bp.route('/status', methods=['GET'])
def get_module_status():
    modules = ModuleStatus.query.all()
    return jsonify([{"name": m.name, "status": m.status, "updated_at": m.updated_at} for m in modules])

@admin_bp.route('/set-status', methods=['POST'])
def set_module_status():
    data = request.get_json()
    name = data.get('module')
    state = data.get('state')  # running, maintenance, down
    if not name or not state:
        return jsonify({"error": "module and state required"}), 400

    m = ModuleStatus.query.filter_by(name=name).first()
    if not m:
        m = ModuleStatus(name=name, status=state)
        db.session.add(m)
    else:
        m.status = state
    db.session.commit()
    return jsonify({"message": "updated", "module": name, "state": state})

@admin_bp.route('/commission/record', methods=['POST'])
def add_commission_record():
    """
    Wallet service should POST commission amounts here after each completed sale.
    Body: { listing_id, seller_id, amount, currency? }
    """
    data = request.get_json()
    try:
        rec = CommissionRecord(
            listing_id = data.get('listing_id'),
            seller_id = data.get('seller_id'),
            amount = float(data.get('amount', 0.0)),
            currency = data.get('currency', 'INR')
        )
        db.session.add(rec)
        db.session.commit()
        return jsonify({"message":"commission recorded", "id": rec.id}), 201
    except Exception as e:
        current_app.logger.error("err add_commission: %s", e)
        return jsonify({"error":"invalid payload"}), 400

@admin_bp.route('/commission/total', methods=['GET'])
def commission_total():
    total = total_commission()
    return jsonify({"total_commission": total})

@admin_bp.route('/commission/daily', methods=['GET'])
def commission_daily():
    days = int(request.args.get('days', 7))
    return jsonify(commission_by_day(days))

@admin_bp.route('/commission/top_sellers', methods=['GET'])
def commission_top_sellers():
    limit = int(request.args.get('limit', 10))
    return jsonify(top_sellers(limit))
