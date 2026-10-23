CREATE TABLE IF NOT EXISTS workforce_non_duplicate_pairs (
 pair_key TEXT PRIMARY KEY,
 created_by INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
