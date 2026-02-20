-- =====================================================
-- 💬 BGMI Chat Service Database Schema (D1)
-- =====================================================
-- This file initializes the chat database with tables
-- for messages and (optional) user records.
-- =====================================================

-- ==============================
-- 🧑‍💬 USERS TABLE (optional)
-- ==============================
-- Note: If you already have a Users table in your Auth Service,
-- you can skip creating this here. It’s useful for local testing.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================
-- 💬 MESSAGES TABLE
-- ==============================
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
);

-- ==============================
-- ⚙️ INDEXES (for faster queries)
-- ==============================
CREATE INDEX IF NOT EXISTS idx_sender_receiver
ON messages (sender_id, receiver_id);

CREATE INDEX IF NOT EXISTS idx_timestamp
ON messages (timestamp);

-- ==============================
-- 🧹 CLEANUP TEST DATA (optional)
-- ==============================
-- DELETE FROM messages WHERE timestamp <= datetime('now', '-7 days');
