from flask import Flask
from flask_cors import CORS
from database import db, init_db
from routes.item_routes import item_bp
from routes.price_routes import price_bp

app = Flask(__name__)
CORS(app)

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///marketplace.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)
init_db(app)

app.register_blueprint(item_bp, url_prefix="/api/market")
app.register_blueprint(price_bp, url_prefix="/api/price")

@app.route('/')
def home():
    return {"message": "Marketplace Service Running"}

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5002 , debug=True)


