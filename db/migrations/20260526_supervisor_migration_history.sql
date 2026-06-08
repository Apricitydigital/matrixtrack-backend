-- Supervisor migration history support
-- Safe to run multiple times (idempotent)

CREATE TABLE IF NOT EXISTS supervisor_transfer_history (
  transfer_id BIGSERIAL PRIMARY KEY,
  supervisor_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  supervisor_emp_code VARCHAR(120),
  supervisor_name VARCHAR(255),
  from_city_id INTEGER REFERENCES cities(city_id) ON DELETE SET NULL,
  from_city_name VARCHAR(255),
  from_zone_id INTEGER REFERENCES zones(zone_id) ON DELETE SET NULL,
  from_zone_name VARCHAR(255),
  from_sector_id INTEGER REFERENCES sectors(sector_id) ON DELETE SET NULL,
  from_sector_name VARCHAR(255),
  from_kothi_id INTEGER REFERENCES wards(ward_id) ON DELETE SET NULL,
  from_kothi_name VARCHAR(255),
  to_city_id INTEGER REFERENCES cities(city_id) ON DELETE SET NULL,
  to_city_name VARCHAR(255),
  to_zone_id INTEGER REFERENCES zones(zone_id) ON DELETE SET NULL,
  to_zone_name VARCHAR(255),
  to_sector_id INTEGER REFERENCES sectors(sector_id) ON DELETE SET NULL,
  to_sector_name VARCHAR(255),
  to_kothi_id INTEGER REFERENCES wards(ward_id) ON DELETE SET NULL,
  to_kothi_name VARCHAR(255),
  transfer_mode VARCHAR(40) NOT NULL,
  transfer_batch_id UUID NOT NULL,
  transfer_key_name VARCHAR(120) NOT NULL,
  transferred_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  transferred_by_name VARCHAR(255),
  transferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supervisor_transfer_history_sup
  ON supervisor_transfer_history(supervisor_id);

CREATE INDEX IF NOT EXISTS idx_supervisor_transfer_history_batch
  ON supervisor_transfer_history(transfer_batch_id);

CREATE INDEX IF NOT EXISTS idx_supervisor_transfer_history_at
  ON supervisor_transfer_history(transferred_at DESC);

