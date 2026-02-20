CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT,
  upi_id TEXT
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  buyer_id TEXT,
  seller_id TEXT,
  total_amount INTEGER,
  admin_commission INTEGER,
  seller_amount INTEGER,
  razorpay_order_id TEXT,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE seller_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT,
  order_id TEXT,
  amount INTEGER,
  status TEXT
);

CREATE TABLE withdraw_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT,
  amount INTEGER,
  upi_id TEXT,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
