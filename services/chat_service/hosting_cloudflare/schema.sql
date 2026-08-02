-- =====================================================
-- 💬 BGMI Chat Service Database Schema (D1)
-- =====================================================

-- ==============================
-- 💬 CHAT ROOMS TABLE
-- ==============================
CREATE TABLE IF NOT EXISTS chat_rooms (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    buyer_id TEXT NOT NULL,
    seller_user_id TEXT NOT NULL,
    status TEXT DEFAULT 'requested',     -- requested / approved / half_paid / closed
    intent TEXT DEFAULT 'chat',          -- chat / buy
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    approved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_buyer ON chat_rooms(buyer_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_seller ON chat_rooms(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_order ON chat_rooms(order_id);

-- ==============================
-- 💬 MESSAGES TABLE
-- ==============================
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    ciphertext TEXT,
    sensitive INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
