-- Professional UI/API: ward_id is sectors.sector_id; kothi_id is wards.ward_id.
-- The original self-punch migration referenced the older hierarchy instead.
-- Keep legacy assignments untouched. NOT VALID enforces the correct references
-- for new/changed keys without requiring a historical assignment conversion.
-- Run inside a transaction; fail promptly rather than block attendance traffic.
SET LOCAL lock_timeout = '3s';

ALTER TABLE self_punch_requests
  DROP CONSTRAINT IF EXISTS self_punch_requests_ward_id_fkey,
  DROP CONSTRAINT IF EXISTS self_punch_requests_kothi_id_fkey;
ALTER TABLE self_punch_requests
  ADD CONSTRAINT self_punch_requests_ward_id_fkey
    FOREIGN KEY (ward_id) REFERENCES sectors(sector_id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT self_punch_requests_kothi_id_fkey
    FOREIGN KEY (kothi_id) REFERENCES wards(ward_id) ON DELETE SET NULL NOT VALID;

ALTER TABLE professional_employees
  DROP CONSTRAINT IF EXISTS professional_employees_ward_id_fkey,
  DROP CONSTRAINT IF EXISTS professional_employees_kothi_id_fkey;
ALTER TABLE professional_employees
  ADD CONSTRAINT professional_employees_ward_id_fkey
    FOREIGN KEY (ward_id) REFERENCES sectors(sector_id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT professional_employees_kothi_id_fkey
    FOREIGN KEY (kothi_id) REFERENCES wards(ward_id) ON DELETE SET NULL NOT VALID;

COMMENT ON COLUMN self_punch_requests.ward_id IS 'Professional ward: sectors.sector_id. Legacy assignments may use the former hierarchy.';
COMMENT ON COLUMN self_punch_requests.kothi_id IS 'Professional kothi: wards.ward_id.';
COMMENT ON COLUMN professional_employees.ward_id IS 'Professional ward: sectors.sector_id. Legacy assignments may use the former hierarchy.';
COMMENT ON COLUMN professional_employees.kothi_id IS 'Professional kothi: wards.ward_id.';
