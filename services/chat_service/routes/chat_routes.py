from flask import Blueprint, request, jsonify
from models import Message
from database import db

chat_bp = Blueprint('chat_bp', __name__)

# === Send Message ===
@chat_bp.route('/send', methods=['POST'])
def send_message():
    data = request.get_json()

    # Input validation
    if not data or 'sender_id' not in data or 'receiver_id' not in data or 'content' not in data:
        return jsonify({"error": "Missing required fields"}), 400

    msg = Message(
        sender_id=data['sender_id'],
        receiver_id=data['receiver_id'],
        content=data['content']
    )

    db.session.add(msg)
    db.session.commit()

    return jsonify({"message": "Message sent successfully", "message_id": msg.id}), 201


# === Get Messages for a User ===
@chat_bp.route('/messages/<int:user_id>', methods=['GET'])
def get_messages(user_id):
    msgs = Message.query.filter(
        (Message.sender_id == user_id) | (Message.receiver_id == user_id)
    ).all()

    result = [
        {
            "id": m.id,
            "sender_id": m.sender_id,
            "receiver_id": m.receiver_id,
            "content": m.content,
            "timestamp": m.timestamp
        }
        for m in msgs
    ]
    return jsonify(result), 200
