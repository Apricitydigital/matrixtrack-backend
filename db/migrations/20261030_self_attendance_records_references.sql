-- self_attendance_records stores the assignment snapshot supplied by the
-- self_attendance profile. Current ward_id values are sectors.sector_id, while
-- many live legacy profiles and historical punches still use wards.ward_id.
-- The namespaces overlap, so neither single-table FK can represent both.
-- Profile/transfer validation enforces the current hierarchy; attendance must
-- accept both generations without guessing or rewriting historical locations.
-- Keep the self_attendance, city and zone foreign keys intact.
SET LOCAL lock_timeout = '3s';

ALTER TABLE self_attendance_records
  DROP CONSTRAINT IF EXISTS self_attendance_records_ward_id_fkey;

COMMENT ON COLUMN self_attendance_records.ward_id IS
  'Assignment snapshot from the self_attendance profile: current sectors.sector_id or legacy wards.ward_id. Validated at profile/transfer time; historical values are preserved.';
