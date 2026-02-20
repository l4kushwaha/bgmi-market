from flask import Flask
from flask_cors import CORS
from routes.auth_routes import auth_bp
from routes.user_routes import user_bp
from routes.admin_routes import admin_bp
from database import db, init_db

app = Flask(__name__)
CORS(app)

# ========================
# 🔧 Configuration
# ========================
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///auth.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = 'supersecretkey'

# ========================
# 🧱 Initialize Database
# ========================
db.init_app(app)
init_db(app)

# ========================
# 📦 Register Blueprints
# ========================
app.register_blueprint(auth_bp, url_prefix="/api/auth")
app.register_blueprint(user_bp, url_prefix="/api/user")
app.register_blueprint(admin_bp, url_prefix="/api/admin")

# ========================
# 🌐 Routes
# ========================
@app.route('/')
def home():
    return {"message": "Auth Service Running"}

# ✅ Health Check Route (for gateway / monitoring)
@app.route('/health')
def health():
    return {"status": "running", "service": "auth"}, 200

# ========================
# 🚀 Run App
# ========================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
