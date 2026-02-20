
from flask import Flask, jsonify
from flask_cors import CORS
from database import db, init_db
from routes.admin_routes import admin_bp
from routes.maintenance_routes import maint_bp
from routes.report_routes import report_bp

app = Flask(__name__)
CORS(app)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///admin.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)
init_db(app)

# Register blueprints
app.register_blueprint(admin_bp, url_prefix='/api/admin')
app.register_blueprint(maint_bp, url_prefix='/api/admin')
app.register_blueprint(report_bp, url_prefix='/api/admin')

@app.route('/')
def home():
    return jsonify({"service":"admin_service","status":"running"})

if __name__ == '__main__':
   app.run(host='0.0.0.0', port=5006 , debug=True)

