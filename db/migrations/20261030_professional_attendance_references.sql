-- professional_attendance stores the assignment snapshot supplied by the
-- professional profile. Current ward_id values are sectors.sector_id, while
-- many live legacy profiles and historical punches still use wards.ward_id.
-- The namespaces overlap, so neither single-table FK can represent both.
-- Profile/transfer validation enforces the current hierarchy; attendance must
-- accept both generations without guessing or rewriting historical locations.
-- Keep the professional, city and zone foreign keys intact.
SET LOCAL lock_timeout = '3s';

ALTER TABLE professional_attendance
  DROP CONSTRAINT IF EXISTS professional_attendance_ward_id_fkey;

COMMENT ON COLUMN professional_attendance.ward_id IS
  'Assignment snapshot from the professional profile: current sectors.sector_id or legacy wards.ward_id. Validated at profile/transfer time; historical values are preserved.';
