CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT,
  upi_id TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  buyer_id TEXT,
  seller_id TEXT,
  total_amount INTEGER,
  admin_commission INTEGER,
  seller_amount INTEGER,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  total_amount REAL NOT NULL,
  admin_fee REAL NOT NULL,
  seller_amount REAL NOT NULL,
  utr TEXT,                             -- UPI transaction reference (direct UPI flow)
  payee_upi TEXT,                       -- UPI ID the buyer paid to (seller's own UPI or admin fallback)
  payee_name TEXT,                      -- display name of payee
  purpose TEXT DEFAULT 'full',          -- full (full listing price) / half (advance half-pay)
  status TEXT DEFAULT 'created',        -- awaiting_confirmation / submitted / paid / released
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_sp_order_id ON service_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_sp_seller_id ON service_payments(seller_id);
CREATE INDEX IF NOT EXISTS idx_sp_buyer_id ON service_payments(buyer_id);

CREATE TABLE IF NOT EXISTS seller_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT,
  order_id TEXT,
  amount REAL,
  status TEXT,                          -- held / released
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_se_seller_id ON seller_earnings(seller_id);

CREATE TABLE IF NOT EXISTS withdraw_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT,
  amount REAL,
  upi_id TEXT,
  status TEXT,                          -- pending / processed / rejected
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wr_seller_id ON withdraw_requests(seller_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
