CREATE TABLE IF NOT EXISTS city_billing_configs (
  city_id INTEGER PRIMARY KEY REFERENCES cities(city_id) ON DELETE CASCADE,
  partner_name VARCHAR(255) NOT NULL DEFAULT '',
  billing_model VARCHAR(32) NOT NULL DEFAULT 'per_attendance',
  rate_per_request_inr NUMERIC(12, 2) NOT NULL DEFAULT 0,
  rate_per_attendance_inr NUMERIC(12, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  updated_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT city_billing_configs_model_chk
    CHECK (billing_model IN ('per_request', 'per_attendance', 'hybrid'))
);

CREATE TABLE IF NOT EXISTS city_daily_traffic_cost (
  id BIGSERIAL PRIMARY KEY,
  metric_date DATE NOT NULL,
  city_id INTEGER NOT NULL REFERENCES cities(city_id) ON DELETE CASCADE,
  source VARCHAR(64) NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  attendance_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  snapshot_s3_key VARCHAR(1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT city_daily_traffic_cost_unique UNIQUE (metric_date, city_id, source)
);

ALTER TABLE city_daily_traffic_cost
  ADD COLUMN IF NOT EXISTS success_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE city_daily_traffic_cost
  DROP CONSTRAINT IF EXISTS city_daily_traffic_cost_source_chk;

ALTER TABLE city_daily_traffic_cost
  DROP CONSTRAINT IF EXISTS city_daily_traffic_cost_counts_chk;

ALTER TABLE city_daily_traffic_cost
  ADD CONSTRAINT city_daily_traffic_cost_source_chk
  CHECK (source IN (
    'group_attendance',
    'individual_attendance',
    'professional_punch_in',
    'professional_punch_out',
    'professional_access_request',
    'face_enrollment'
  ));

ALTER TABLE city_daily_traffic_cost
  ADD CONSTRAINT city_daily_traffic_cost_counts_chk
  CHECK (
    request_count >= 0 AND
    attendance_count >= 0 AND
    success_count >= 0 AND
    failure_count >= 0
  );

CREATE INDEX IF NOT EXISTS idx_city_daily_traffic_cost_date
  ON city_daily_traffic_cost (metric_date DESC);

CREATE INDEX IF NOT EXISTS idx_city_daily_traffic_cost_city_date
  ON city_daily_traffic_cost (city_id, metric_date DESC);
