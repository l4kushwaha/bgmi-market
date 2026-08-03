-- 💰 Seller commission system (2.5% per sale payable to admin)
ALTER TABLE sellers ADD COLUMN pending_commission REAL DEFAULT 0;
ALTER TABLE sellers ADD COLUMN hidden INTEGER DEFAULT 0;

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

-- 🎯 Popularity boost: buyer ka game UID (jis pe pop dalni hai)
ALTER TABLE purchases ADD COLUMN target_uid TEXT;
