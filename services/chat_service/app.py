from flask import Flask, jsonify
from flask_cors import CORS
from database import db
from routes.chat_routes import chat_bp

app = Flask(__name__)
CORS(app)

# === Configuration ===
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# === Initialize DB ===
db.init_app(app)

# === Register Routes ===
app.register_blueprint(chat_bp, url_prefix='/chat')

@app.route('/')
def home():
    return jsonify({"message": "Chat Service Active"}), 200

# === Run Service ===
if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=5005 , debug=True)
