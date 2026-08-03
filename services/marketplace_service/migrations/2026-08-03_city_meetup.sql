-- 🏙️ City-wise search + 🤝 real meetup system
ALTER TABLE sellers ADD COLUMN city TEXT;
ALTER TABLE sellers ADD COLUMN meetup_note TEXT;
ALTER TABLE listings ADD COLUMN meetup_available INTEGER DEFAULT 0;
ALTER TABLE listings ADD COLUMN city TEXT;

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
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meetups_buyer ON meetup_requests(buyer_id);
CREATE INDEX IF NOT EXISTS idx_meetups_seller ON meetup_requests(seller_id);
CREATE INDEX IF NOT EXISTS idx_meetups_status ON meetup_requests(status);
