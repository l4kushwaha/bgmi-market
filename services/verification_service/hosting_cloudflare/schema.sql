-- ========================================================
-- 🛡️ BGMI Verification Service Database Schema
-- ========================================================

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
  bio TEXT,
  instagram TEXT,
  facebook TEXT,
  upi_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 🧾 KYC verification table
CREATE TABLE IF NOT EXISTS kyc_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  document_type TEXT, -- Aadhaar / PAN / Other
  document_key TEXT, -- R2 key for document photo
  video_key TEXT, -- R2 key for video KYC
  liveness_result TEXT, -- JSON: {passed, face_detected, prompts_completed}
  verification_status TEXT DEFAULT 'pending', -- pending / approved / rejected
  confidence REAL,
  remarks TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  reviewed_by TEXT,
  approved_at TEXT -- set on approval, used for 7-day auto-purge
);
CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_documents(verification_status);

-- 🧠 Verification logs (OCR, Face match)
CREATE TABLE IF NOT EXISTS verification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT, -- face / ocr / ekyc
  result TEXT,
  confidence REAL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vlogs_user ON verification_logs(user_id);

-- 🛍️ Seller statistics table
CREATE TABLE IF NOT EXISTS seller_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  total_ids_sold INTEGER DEFAULT 0,
  total_earnings REAL DEFAULT 0,
  badge TEXT DEFAULT 'New Seller',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_seller_stats_id ON seller_stats(seller_id);

-- Security: Rate limiting for KYC uploads
CREATE TABLE IF NOT EXISTS kyc_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, endpoint, window_start)
);
