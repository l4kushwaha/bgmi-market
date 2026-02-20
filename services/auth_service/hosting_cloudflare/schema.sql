-- =====================================================
-- 🌐 BGMI Shared Database Schema
-- =====================================================

-- =========================
-- Users (Auth Service)
-- =========================
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',  -- user / admin
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- User Profiles
-- =========================
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

-- =========================
-- User Activity Logs
-- =========================
CREATE TABLE IF NOT EXISTS user_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT,             -- login_success, login_failed, profile_update, register
  details TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- KYC Documents (Verification Service)
-- =========================
CREATE TABLE IF NOT EXISTS kyc_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  document_type TEXT,        -- Aadhaar / PAN / Other
  verification_status TEXT DEFAULT 'pending',
  confidence REAL,
  remarks TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- Verification Logs (OCR / Face Match)
-- =========================
CREATE TABLE IF NOT EXISTS verification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT,                 -- face / ocr / ekyc
  result TEXT,
  confidence REAL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- Seller Statistics (Verification Service)
-- =========================
CREATE TABLE IF NOT EXISTS seller_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  total_ids_sold INTEGER DEFAULT 0,
  total_earnings REAL DEFAULT 0,
  badge TEXT DEFAULT 'New Seller',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
