-- Sectors (Wards) table and FK to wards (Kothis)
-- Hierarchy: City -> Zone -> Sector/Ward -> (optional) Kothis
-- Run with: psql -h <host> -U <user> -d <dbname> -f 20260228_create_sectors_table.sql

-- 1. Create sectors table
CREATE TABLE IF NOT EXISTS sectors (
  sector_id   SERIAL PRIMARY KEY,
  sector_name VARCHAR(100) NOT NULL,
  zone_id     INTEGER NOT NULL REFERENCES zones(zone_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_sector_per_zone UNIQUE (sector_name, zone_id)
);

CREATE INDEX IF NOT EXISTS idx_sectors_zone_id ON sectors (zone_id);

-- 2. Add sector_id FK to wards table (so Kothis can belong to a Ward)
ALTER TABLE wards
  ADD COLUMN IF NOT EXISTS sector_id INTEGER REFERENCES sectors(sector_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wards_sector_id ON wards (sector_id);
