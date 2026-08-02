-- ========================================================
-- 🛒 BGMI Marketplace — Popularity + Seller Verification
-- Adds columns to existing tables (idempotent-ish: run once)
-- ========================================================

ALTER TABLE listings ADD COLUMN category TEXT DEFAULT 'account';
ALTER TABLE listings ADD COLUMN points INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS popularity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  source TEXT DEFAULT 'purchase',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seller_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  badge TEXT,
  reason TEXT,
  reviewed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_popularity_user_id ON popularity(user_id);
CREATE INDEX IF NOT EXISTS idx_seller_verify_user_id ON seller_verifications(user_id, status);
