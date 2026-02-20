from flask import Blueprint, request, jsonify
from models import ModuleStatus
from database import db

maint_bp = Blueprint('maint_bp', __name__)

# ===== Helper function to verify admin =====
def is_admin(data):
    """Check admin credentials before allowing updates."""
    admin_email = "L4kushwaha@gmail.com"
    admin_pass = "ELEGENT1832"
    admin_mobile = "7905584212"

    return (
        data.get("email") == admin_email
        and data.get("password") == admin_pass
        and data.get("mobile") == admin_mobile
    )

# ===== List all modules =====
@maint_bp.route('/modules', methods=['GET'])
def list_modules():
    modules = ModuleStatus.query.all()
    return jsonify([
        {
            "name": m.name,
            "status": m.status,
            "updated_at": m.updated_at
        } for m in modules
    ]), 200

# ===== Create a new module =====
@maint_bp.route('/module', methods=['POST'])
def create_module():
    data = request.get_json()
    name = data.get('name')

    if not name:
        return jsonify({"error": "Module name is required"}), 400

    if ModuleStatus.query.filter_by(name=name).first():
        return jsonify({"error": "Module already exists"}), 400

    module = ModuleStatus(name=name, status='running')
    db.session.add(module)
    db.session.commit()

    return jsonify({
        "message": "Module created successfully",
        "name": name,
        "status": module.status
    }), 201

# ===== Update module status (Admin Only) =====
@maint_bp.route('/module/update', methods=['PUT'])
def update_module():
    data = request.get_json()

    # ✅ Verify admin before allowing update
    if not is_admin(data):
        return jsonify({"error": "Unauthorized. Admin access required."}), 403

    name = data.get('name')
    status = data.get('status')

    if not name or not status:
        return jsonify({"error": "Both name and status are required"}), 400

    module = ModuleStatus.query.filter_by(name=name).first()
    if not module:
        return jsonify({"error": f"No module found with name '{name}'"}), 404

    module.status = status.lower()
    db.session.commit()

    return jsonify({
        "message": f"Module '{name}' updated to '{status}'",
        "name": name,
        "status": module.status
    }), 200

# ===== Delete module (Admin Only) =====
@maint_bp.route('/module/delete', methods=['DELETE'])
def delete_module():
    data = request.get_json()

    # ✅ Verify admin before allowing delete
    if not is_admin(data):
        return jsonify({"error": "Unauthorized. Admin access required."}), 403

    name = data.get('name')
    if not name:
        return jsonify({"error": "Module name is required"}), 400

    module = ModuleStatus.query.filter_by(name=name).first()
    if not module:
        return jsonify({"error": "Module not found"}), 404

    db.session.delete(module)
    db.session.commit()

    return jsonify({"message": f"Module '{name}' deleted successfully"}), 200
