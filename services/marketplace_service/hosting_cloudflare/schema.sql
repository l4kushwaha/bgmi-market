-- ========================================================
-- 🛡️ BGMI Marketplace Database Schema (marketplace-db)
-- Extended for Wallet + Admin + Chat Integration
-- ========================================================

PRAGMA foreign_keys = ON;

-- ========================================================
-- 👤 USERS TABLE (Reference to AUTH_SERVICE)
-- ========================================================
-- NOTE: This table acts as a local cache (optional) for user info
-- Actual verification (JWT + KYC) happens via auth_service API
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  username TEXT,
  role TEXT DEFAULT 'user',              -- user / admin
  kyc_verified INTEGER DEFAULT 0,        -- 0 = pending, 1 = verified
  created_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================
-- 🛒 LISTINGS TABLE
-- ========================================================
-- Stores all BGMI ID listings created by sellers
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT NOT NULL,               -- user id from auth_service
  uid TEXT UNIQUE NOT NULL,              -- PUBG UID (unique identifier)
  title TEXT NOT NULL,
  description TEXT,

  -- ⚔️ Inventory stats
  mythic_count INTEGER DEFAULT 0,
  legendary_count INTEGER DEFAULT 0,
  xsuit_count INTEGER DEFAULT 0,
  gilt_count INTEGER DEFAULT 0,
  honor_gilt_set INTEGER DEFAULT 0,
  upgradable_guns INTEGER DEFAULT 0,
  rare_glider INTEGER DEFAULT 0,
  vehicle_skin INTEGER DEFAULT 0,
  special_titles INTEGER DEFAULT 0,
  rank TEXT,
  level INTEGER DEFAULT 0,

  -- 💰 Pricing info
  price REAL DEFAULT 0,                  -- Auto-calculated base price
  custom_price REAL,                     -- Manually updated by seller/admin
  price_breakdown TEXT,                  -- JSON: detailed breakdown
  label TEXT,                            -- Basic / Elite / Premium

  -- 🖼️ Media & highlights
  images TEXT,                           -- JSON array of URLs
  highlights TEXT,                       -- seller’s highlight message
  status TEXT DEFAULT 'available',       -- available / pending / sold / hidden
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ========================================================
-- ⚖️ PRICE WEIGHTS TABLE
-- ========================================================
-- Admin can tune weights for price calculation logic
CREATE TABLE IF NOT EXISTS price_weights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mythic_weight REAL DEFAULT 200,
  legendary_weight REAL DEFAULT 100,
  xsuit_weight REAL DEFAULT 500,
  gilt_weight REAL DEFAULT 300,
  honor_gilt_weight REAL DEFAULT 400,
  upgradable_gun_weight REAL DEFAULT 250,
  rare_glider_weight REAL DEFAULT 150,
  vehicle_skin_weight REAL DEFAULT 180,
  special_title_weight REAL DEFAULT 220,
  rank_weight REAL DEFAULT 100,
  level_weight REAL DEFAULT 5,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Insert default weights if not already present
INSERT INTO price_weights (
  mythic_weight, legendary_weight, xsuit_weight,
  gilt_weight, honor_gilt_weight, upgradable_gun_weight,
  rare_glider_weight, vehicle_skin_weight, special_title_weight,
  rank_weight, level_weight
)
SELECT 200, 100, 500, 300, 400, 250, 150, 180, 220, 100, 5
WHERE NOT EXISTS (SELECT 1 FROM price_weights);

-- ========================================================
-- ⭐ REVIEWS TABLE
-- ========================================================
-- Buyers can rate and review purchased listings
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  images TEXT,                           -- JSON array of URLs (optional)
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

-- ========================================================
-- 💸 PURCHASES TABLE
-- ========================================================
-- Stores purchase transactions (linking to wallet_service + chat_service)
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  price REAL NOT NULL,
  payment_method TEXT,                   -- wallet / upi / paytm / gpay / phonepe
  payment_status TEXT DEFAULT 'pending', -- pending / success / failed / refunded
  delivery_status TEXT DEFAULT 'awaiting', -- awaiting / delivered / confirmed
  transaction_ref TEXT,                  -- wallet/upi transaction id
  chat_conversation_id TEXT,             -- for chat_service integration
  escrow_held INTEGER DEFAULT 0,         -- 0 = not held, 1 = in escrow
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

-- ========================================================
-- 🧾 TRANSACTION LOGS TABLE
-- ========================================================
-- Admin & wallet_service can use this for audit trail
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
  action_type TEXT,                      -- approve_listing / hide / ban / refund
  target_id TEXT,                        -- listing_id / user_id / purchase_id
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (admin_id) REFERENCES users(id)
);

-- ========================================================
-- 💬 CHAT LINKS TABLE (for Chat Service)
-- ========================================================
-- Stores mapping of marketplace transactions to chat conversations
CREATE TABLE IF NOT EXISTS chat_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  conversation_id TEXT UNIQUE,           -- from chat_service
  last_message TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
);

-- ========================================================
-- ⚡ INDEXES (for performance)
-- ========================================================
CREATE INDEX IF NOT EXISTS idx_listings_seller_id ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_reviews_listing_id ON reviews(listing_id);
CREATE INDEX IF NOT EXISTS idx_purchases_buyer_id ON purchases(buyer_id);
CREATE INDEX IF NOT EXISTS idx_purchases_seller_id ON purchases(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_seller_id ON transaction_logs(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_buyer_id ON transaction_logs(buyer_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_admin_id ON admin_actions(admin_id);
CREATE INDEX IF NOT EXISTS idx_chat_links_conversation_id ON chat_links(conversation_id);
