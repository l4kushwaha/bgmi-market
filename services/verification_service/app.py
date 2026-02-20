from flask import Flask, jsonify
from flask_cors import CORS
from database import db
from ocr_verify import orc_bp
from face_verify import face_bp
import os

# === App Setup ===
app = Flask(__name__)
CORS(app)

# === Configuration ===
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + os.path.join(BASE_DIR, "verification.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = "verification_secret_key"

# === Initialize DB ===
db.init_app(app)

# === Register Blueprints ===
app.register_blueprint(orc_bp, url_prefix="/verification")
app.register_blueprint(face_bp, url_prefix="/verification")

# === Health Check ===
@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "service": "verification_service",
        "status": "running"
    }), 200

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "verification": "ok"
    }), 200

# === Start Server ===
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    print("✅ Verification Service running on http://localhost:5006")
    app.run(host="0.0.0.0", port=5004, debug=True)
