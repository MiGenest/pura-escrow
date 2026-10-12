-- The three tables the escrow demo's worker reads and writes, as production
-- has them at 50f6661 with every migration applied, each folded into a single
-- CREATE TABLE. Column order is production's: GET /api/cargo and
-- GET /api/cargo/history answer with SELECT * rows, so it is also the key
-- order of what they send back.
--
--   npx wrangler d1 execute pura-escrow-demo --local --file=schema.sql

-- Off-chain metadata for one on-chain booking, keyed by the booking PDA.
CREATE TABLE IF NOT EXISTS cargo (
  booking_pda            TEXT PRIMARY KEY,
  shipper                TEXT NOT NULL,
  weight_kg              INTEGER,
  volume_m3              REAL,
  description            TEXT,
  pickup_name            TEXT,
  dropoff_name           TEXT,
  contact_name           TEXT,
  contact_phone          TEXT,
  price_usd              INTEGER,
  distance_km            REAL,
  created_at             INTEGER NOT NULL,
  delivery_photo         TEXT,
  waypoints              TEXT,
  disputed               INTEGER NOT NULL DEFAULT 0,
  dispute_reason         TEXT,
  disputed_by            TEXT,
  dispute_status         TEXT NOT NULL DEFAULT 'open',
  required_vehicle_type  TEXT,
  carrier                TEXT,
  completed_status       TEXT,
  completed_amount       INTEGER,
  completed_at           INTEGER,
  pickup_contact_name    TEXT,
  pickup_contact_phone   TEXT,
  dropoff_contact_name   TEXT,
  dropoff_contact_phone  TEXT,
  corridor               TEXT,
  pickup_country         TEXT,
  dropoff_country        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cargo_carrier   ON cargo(carrier);
CREATE INDEX IF NOT EXISTS idx_cargo_completed ON cargo(completed_status, completed_at);
CREATE INDEX IF NOT EXISTS idx_cargo_corridor  ON cargo(corridor);
CREATE INDEX IF NOT EXISTS idx_cargo_shipper   ON cargo(shipper);

-- One profile per wallet, written by POST /api/profile.
CREATE TABLE IF NOT EXISTS users (
  wallet                     TEXT PRIMARY KEY,
  role                       TEXT NOT NULL,
  name                       TEXT,
  company                    TEXT,
  phone                      TEXT,
  email                      TEXT,
  plate                      TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  license_doc                TEXT,
  insurance_doc              TEXT,
  verification_status        TEXT NOT NULL DEFAULT 'unverified',
  max_weight_kg              REAL,
  max_volume_m3              REAL,
  vehicle_type               TEXT,
  verification_requested_at  INTEGER
);

-- One row per countersigned transaction. The per-wallet and per-IP hourly
-- limits and the daily lamports cap (sponsor.js) count from this table.
CREATE TABLE IF NOT EXISTS fee_sponsorships (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  ip              TEXT,
  lamports_spent  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fee_sponsorships_created_at ON fee_sponsorships(created_at);
CREATE INDEX IF NOT EXISTS idx_fee_sponsorships_ip         ON fee_sponsorships(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_fee_sponsorships_wallet     ON fee_sponsorships(wallet, created_at);
