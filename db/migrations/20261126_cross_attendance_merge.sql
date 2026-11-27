-- Original profiles, attendance and dependent evidence remain permanently available
-- even after the optional 48-hour recovery window expires.
ALTER TABLE workforce_employee_aliases ADD COLUMN IF NOT EXISTS auth_enabled BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS workforce_transfer_archive (
 id BIGSERIAL PRIMARY KEY, merge_id BIGINT NOT NULL REFERENCES workforce_merge_audit(id),
 employee_kind TEXT NOT NULL, employee_id TEXT NOT NULL, source_table TEXT NOT NULL,
 original_rows JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS workforce_transfer_archive_merge ON workforce_transfer_archive(merge_id);
CREATE TABLE IF NOT EXISTS workforce_cross_attendance_aliases (
 employee_kind TEXT NOT NULL CHECK(employee_kind IN ('regular','self_attendance')),
 source_id TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('regular','self_attendance')),
 target_id TEXT NOT NULL, emp_code TEXT, merge_id BIGINT NOT NULL REFERENCES workforce_merge_audit(id),
 PRIMARY KEY(employee_kind,source_id), CHECK(employee_kind<>target_kind)
);
CREATE TABLE IF NOT EXISTS workforce_separation_audit (
 id BIGSERIAL PRIMARY KEY, employee_kind TEXT NOT NULL, employee_id TEXT NOT NULL,
 other_kind TEXT NOT NULL, other_id TEXT NOT NULL, previous_code TEXT, new_code TEXT NOT NULL,
 actor_user_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE workforce_separation_audit ADD COLUMN IF NOT EXISTS profile_changes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS transfer_original JSONB;
ALTER TABLE self_attendance_records ADD COLUMN IF NOT EXISTS transfer_original JSONB;

-- Old clients must refresh after changing attendance systems. Never cast a UUID
-- into an integer or accept an orphan write for a retired cross-system ID.
CREATE OR REPLACE FUNCTION workforce_block_cross_attendance_write() RETURNS TRIGGER AS $$
BEGIN
 IF current_setting('matrixtrack.merge_replay',true)='on' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM workforce_cross_attendance_aliases
   WHERE employee_kind=TG_ARGV[0] AND source_id=to_jsonb(NEW)->>TG_ARGV[1]) THEN
  RAISE EXCEPTION 'Employee moved to another attendance system. Refresh the employee list.' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
