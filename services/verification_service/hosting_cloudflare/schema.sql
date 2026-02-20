-- 🧩 Create user profile table
CREATE TABLE IF NOT EXISTS user_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  name TEXT,
  gender TEXT,
  dob TEXT,
  address TEXT,
  photo_url TEXT,
  aadhaar_number TEXT,
  pan_number TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 🧾 KYC verification table
CREATE TABLE IF NOT EXISTS kyc_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  document_type TEXT, -- Aadhaar / PAN / Other
  verification_status TEXT DEFAULT 'pending',
  confidence REAL,
  remarks TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 🧠 Verification logs (OCR, Face match)
CREATE TABLE IF NOT EXISTS verification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT, -- face / ocr / ekyc
  result TEXT,
  confidence REAL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 🛍️ Seller statistics table
CREATE TABLE IF NOT EXISTS seller_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  total_ids_sold INTEGER DEFAULT 0,
  total_earnings REAL DEFAULT 0,
  badge TEXT DEFAULT 'New Seller',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
