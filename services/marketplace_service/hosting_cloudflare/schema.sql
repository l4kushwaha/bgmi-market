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
  category TEXT DEFAULT 'account',       -- account / popularity
  points INTEGER DEFAULT 0,              -- popularity points (when category=popularity)
  delivery_time TEXT,                    -- popularity boost delivery estimate (buyer chooses at purchase)
  price REAL DEFAULT 0,
  level INTEGER DEFAULT 0,
  highest_rank TEXT,
  mythic_items TEXT,                     -- JSON array
  legendary_items TEXT,
  honor_gift TEXT,                       -- JSON array (Honor Gift items)
  upgraded_guns TEXT,
  titles TEXT,
  x_suit TEXT,                           -- JSON array (X Suit skins)
  supercar TEXT,                         -- JSON array (Supercars)
  ultimate TEXT,                         -- JSON array (Ultimate items)
  images TEXT,                           -- JSON array of URLs
  status TEXT DEFAULT 'available',       -- available / pending / sold / hidden
  meetup_available INTEGER DEFAULT 0,    -- 1 = seller offers real meetup for this listing
  city TEXT,                             -- seller city (for city-wise search / meetup)
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
  city TEXT,                             -- seller city (city-wise search)
  meetup_note TEXT,                      -- safety note shown for meetups
  pending_commission REAL DEFAULT 0,     -- 2.5% per sale, payable to admin
  hidden INTEGER DEFAULT 0,              -- 1 = hidden from users (unpaid commission)
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
  delivery_time TEXT,                    -- buyer's chosen boost delivery time
  target_uid TEXT,                       -- popularity boost: buyer's BGMI UID (jis pe pop dalni hai)
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
-- 💸 COMMISSION PAYMENTS TABLE (2.5% seller commission)
-- ========================================================
CREATE TABLE IF NOT EXISTS commission_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'submitted',        -- submitted / paid / rejected
  utr TEXT,
  reviewed_by TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cp_seller ON commission_payments(seller_id);
CREATE INDEX IF NOT EXISTS idx_cp_status ON commission_payments(status);

-- ========================================================
-- ⭐ POPULARITY TABLE (per-user popularity points ledger)
-- ========================================================
CREATE TABLE IF NOT EXISTS popularity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  source TEXT DEFAULT 'purchase',       -- purchase / admin / bonus
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ========================================================
-- ✅ SELLER VERIFICATION REQUESTS TABLE
-- ========================================================
CREATE TABLE IF NOT EXISTS seller_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',        -- pending / approved / rejected
  badge TEXT,                           -- badge to grant on approval
  reason TEXT,
  reviewed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ========================================================
-- 🤝 MEETUP REQUESTS TABLE (real-world ID delivery)
-- ========================================================
CREATE TABLE IF NOT EXISTS meetup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  city TEXT,
  location TEXT,
  meet_date TEXT,
  meet_time TEXT,
  note TEXT,
  status TEXT DEFAULT 'pending',        -- pending / approved / declined / completed / cancelled
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meetups_buyer ON meetup_requests(buyer_id);
CREATE INDEX IF NOT EXISTS idx_meetups_seller ON meetup_requests(seller_id);
CREATE INDEX IF NOT EXISTS idx_meetups_status ON meetup_requests(status);

-- ========================================================
-- 💰 PRICE CONFIG (admin-editable estimate prices)
-- ========================================================
CREATE TABLE IF NOT EXISTS price_config (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
CREATE INDEX IF NOT EXISTS idx_popularity_user_id ON popularity(user_id);
CREATE INDEX IF NOT EXISTS idx_seller_verify_user_id ON seller_verifications(user_id, status);
