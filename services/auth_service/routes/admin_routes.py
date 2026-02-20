from flask import Blueprint, jsonify
from models import User

admin_bp = Blueprint('admin_bp', __name__)

@admin_bp.route("/all-users", methods=["GET"])
def get_all_users():
    """
    Returns a list of all registered users.
    (Admin can view all users)
    """
    users = User.query.all()
    result = []
    for u in users:
        result.append({
            "id": u.id,
            "full_name": u.full_name,
            "email": u.email,
            "phone": u.phone
        })
    return jsonify(result), 200
