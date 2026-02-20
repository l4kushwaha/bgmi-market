from flask import Blueprint, request, jsonify
from models import BGMI_ID, db
from price_calculator import estimate_price

item_bp = Blueprint('item_bp', __name__)

@item_bp.route('/list', methods=['POST'])
def list_id():
    data = request.get_json()
    new_item = BGMI_ID(
        seller_id=data['seller_id'],
        uid=data['uid'],
        rank=data['rank'],
        mythic_count=data['mythic_count'],
        legendary_count=data['legendary_count'],
        x_suit_count=data['x_suit_count'],
        price=data['price']
    )
    db.session.add(new_item)
    db.session.commit()
    return jsonify({"message": "ID listed successfully"}), 201

@item_bp.route('/all', methods=['GET'])
def all_items():
    items = BGMI_ID.query.filter_by(status="available").all()
    data = [{"uid": i.uid, "price": i.price, "rank": i.rank} for i in items]
    return jsonify(data), 200

@item_bp.route('/mark_sold/<uid>', methods=['PUT'])
def mark_sold(uid):
    item = BGMI_ID.query.filter_by(uid=uid).first()
    if not item:
        return jsonify({"error": "Item not found"}), 404
    item.status = "sold"
    db.session.commit()
    return jsonify({"message": "Item marked as sold"}), 200

