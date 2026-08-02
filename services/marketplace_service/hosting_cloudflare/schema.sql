-- ========================================================
-- 🛡️ BGMI Marketplace Database Schema (marketplace-db)
-- ========================================================

PRAGMA foreign_keys = ON;

-- ========================================================
-- 👤 USERS TABLE (Reference to AUTH_SERVICE)
-- ========================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  username TEXT,
  role TEXT DEFAULT 'user',              -- user / seller / admin
  kyc_verified INTEGER DEFAULT 0,        -- 0 = pending, 1 = verified
  created_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================
-- 🛒 LISTINGS TABLE
-- ========================================================
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT NOT NULL,               -- user id from auth_service
  uid TEXT NOT NULL,                     -- PUBG UID
  title TEXT NOT NULL,
  description TEXT,
  price REAL DEFAULT 0,
  level INTEGER DEFAULT 0,
  highest_rank TEXT,
  mythic_items TEXT,                     -- JSON array
  legendary_items TEXT,
  gift_items TEXT,
  upgraded_guns TEXT,
  titles TEXT,
  images TEXT,                           -- JSON array of URLs
  status TEXT DEFAULT 'available',       -- available / pending / sold / hidden
  avg_rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  seller_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ========================================================
-- 👤 SELLERS TABLE
-- ========================================================
CREATE TABLE IF NOT EXISTS sellers (
  user_id TEXT PRIMARY KEY,              -- references users(id)
  stars REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  badge TEXT DEFAULT 'new',              -- new / trusted
  status TEXT DEFAULT 'active',          -- active / banned
  total_sales INTEGER DEFAULT 0,
  total_revenue REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ========================================================
-- ⭐ REVIEWS TABLE
-- ========================================================
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  reply TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

-- ========================================================
-- 💸 PURCHASES TABLE
-- ========================================================
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  price REAL NOT NULL,
  payment_status TEXT DEFAULT 'pending', -- pending / paid / released / refunded
  delivery_status TEXT DEFAULT 'awaiting', -- awaiting / delivered / confirmed
  transaction_ref TEXT,
  escrow_held INTEGER DEFAULT 0,         -- 0 = no, 1 = in escrow
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

-- ========================================================
-- 🧾 TRANSACTION LOGS TABLE
-- ========================================================
CREATE TABLE IF NOT EXISTS transaction_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  buyer_id TEXT,
  seller_id TEXT,
  amount REAL,
  type TEXT,                             -- credit / debit / refund / escrow
  source_service TEXT DEFAULT 'marketplace',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
);

-- ========================================================
-- ⚙️ ADMIN ACTIONS TABLE (for moderation / disputes)
-- ========================================================
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action_type TEXT,
  target_id TEXT,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (admin_id) REFERENCES users(id)
);

-- ========================================================
-- 💬 CHAT LINKS TABLE (for Chat Service)
-- ========================================================
CREATE TABLE IF NOT EXISTS chat_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  conversation_id TEXT UNIQUE,
  last_message TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
);

-- ========================================================
-- ⚡ INDEXES
-- ========================================================
CREATE INDEX IF NOT EXISTS idx_listings_seller_id ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_reviews_listing_id ON reviews(listing_id);
CREATE INDEX IF NOT EXISTS idx_reviews_seller_id ON reviews(seller_id);
CREATE INDEX IF NOT EXISTS idx_purchases_buyer_id ON purchases(buyer_id);
CREATE INDEX IF NOT EXISTS idx_purchases_seller_id ON purchases(seller_id);
CREATE INDEX IF NOT EXISTS idx_purchases_listing_id ON purchases(listing_id);
CREATE INDEX IF NOT EXISTS idx_transactions_seller_id ON transaction_logs(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_buyer_id ON transaction_logs(buyer_id);
