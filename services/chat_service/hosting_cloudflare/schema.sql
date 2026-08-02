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
    approved_at DATETIME,
    closed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_buyer ON chat_rooms(buyer_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_seller ON chat_rooms(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_order ON chat_rooms(order_id);

-- ==============================
-- dY'� MESSAGES TABLE (private chat)
-- ==============================
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    type TEXT DEFAULT 'text',          -- text / image / voice / system
    ciphertext TEXT,
    sensitive INTEGER DEFAULT 0,
    media TEXT,                        -- KV key when type = voice
    media_type TEXT,                   -- audio/webm ...
    effect TEXT,                       -- glitch / rainbow / sparkle / fire / neon
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- ==============================
-- 💬 GLOBAL MESSAGES TABLE (global chat)
-- ==============================
CREATE TABLE IF NOT EXISTS global_messages (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,             -- bgmi / free_fire / general
    sender_id TEXT NOT NULL,
    username TEXT,
    message TEXT,
    media TEXT,                        -- KV key when type = voice
    media_type TEXT,
    effect TEXT,                       -- glitch / rainbow / sparkle / fire / neon
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_global_channel ON global_messages(channel, created_at);
CREATE INDEX IF NOT EXISTS idx_global_sender ON global_messages(sender_id, created_at);

-- ==============================
-- 📞 CALLS TABLE (WebRTC signaling)
-- ==============================
CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    caller_id TEXT NOT NULL,
    callee_id TEXT NOT NULL,
    kind TEXT DEFAULT 'audio',         -- audio / video
    status TEXT DEFAULT 'ringing',     -- ringing / connected / ended / missed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_calls_room ON calls(room_id, status);

-- ==============================
-- 📞 CALL SIGNALING EVENTS (offer / answer / ice / hangup)
-- ==============================
CREATE TABLE IF NOT EXISTS call_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    type TEXT NOT NULL,                -- offer / answer / ice / hangup
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id, id);

