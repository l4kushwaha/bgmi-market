
from flask import Blueprint, request, jsonify
from price_calculator import estimate_price

price_bp = Blueprint('price_bp', __name__)

@price_bp.route('/check', methods=['POST'])
def check_price():
    data = request.get_json()
    mythic = int(data.get("mythic_count", 0))
    legendary = int(data.get("legendary_count", 0))
    x_suit = int(data.get("x_suit_count", 0))
    result = estimate_price(mythic, legendary, x_suit)
    return jsonify(result), 200
