
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

app = Flask(__name__, template_folder='templates')
CORS(app)

# === Config ===
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS", "your_email@gmail.com")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD", "your_email_password")

# --- Utility: Send Email ---
def send_email(to_email, subject, html_content):
    try:
        msg = MIMEMultipart()
        msg["From"] = EMAIL_ADDRESS
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.attach(MIMEText(html_content, "html"))

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(EMAIL_ADDRESS, EMAIL_PASSWORD)
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"[ERROR] Email not sent: {e}")
        return False


# --- Route: Verification Success ---
@app.route("/notify/verification", methods=["POST"])
def notify_verification():
    data = request.json
    email = data.get("email")
    username = data.get("username")

    if not email:
        return jsonify({"error": "Email required"}), 400

    html_content = render_template("verification_done.html", username=username)
    sent = send_email(email, "✅ Verification Successful", html_content)
    return jsonify({"status": "sent" if sent else "failed"})


# --- Route: Sale Success ---
@app.route("/notify/sale_success", methods=["POST"])
def notify_sale_success():
    data = request.json
    email = data.get("email")
    username = data.get("username")
    item_name = data.get("item_name")
    price = data.get("price")

    if not email:
        return jsonify({"error": "Email required"}), 400

    html_content = render_template("sale_success.html", username=username, item_name=item_name, price=price)
    sent = send_email(email, "🎉 Sale Completed!", html_content)
    return jsonify({"status": "sent" if sent else "failed"})


@app.route("/", methods=["GET"])
def home():
    return jsonify({"service": "notification_service", "status": "running"})


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5007 , debug=True)
