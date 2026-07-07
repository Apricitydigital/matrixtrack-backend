-- =============================================================================
-- MIGRATION: Self Punch-In Feature (DOWN / ROLLBACK)
-- Version   : 20260505_self_punch_in_down.sql
--
-- ⚠️  WARNING: THIS IS DESTRUCTIVE.
--     All self-punch request, log, professional employee, and attendance data
--     will be permanently dropped. Run ONLY after a verified database backup
--     and only on non-production environments unless you are certain.
--
-- The kothi_assignments PRIMARY KEY added by the UP migration is left in place
-- because other parts of the schema may have started using it.  If you need to
-- revert that too, uncomment the final section.
--
-- Run with: psql -h <host> -U <user> -d <db> -f 20260505_self_punch_in_down.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 5. professional_attendance  (depends on professional_employees)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_pa_open_punches;
DROP INDEX IF EXISTS idx_pa_ward_date;
DROP INDEX IF EXISTS idx_pa_city_id;
DROP INDEX IF EXISTS idx_pa_zone_id;
DROP INDEX IF EXISTS idx_pa_ward_id;
DROP INDEX IF EXISTS idx_pa_date;
DROP INDEX IF EXISTS idx_pa_professional_id;

DROP TABLE IF EXISTS professional_attendance;


-- ---------------------------------------------------------------------------
-- 4. professional_employees  (depends on self_punch_requests + kothi_assignments)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_pe_lock_selfie ON professional_employees;
DROP FUNCTION IF EXISTS prevent_selfie_update();

DROP INDEX IF EXISTS idx_pe_is_active;
DROP INDEX IF EXISTS idx_pe_mobile;
DROP INDEX IF EXISTS idx_pe_city_id;
DROP INDEX IF EXISTS idx_pe_zone_id;
DROP INDEX IF EXISTS idx_pe_ward_id;

DROP TABLE IF EXISTS professional_employees;


-- ---------------------------------------------------------------------------
-- 3. self_punch_request_logs  (depends on self_punch_requests)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_sprl_created_at;
DROP INDEX IF EXISTS idx_sprl_actor;
DROP INDEX IF EXISTS idx_sprl_request_id;

DROP TABLE IF EXISTS self_punch_request_logs;


-- ---------------------------------------------------------------------------
-- 2. self_punch_requests  (root table)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_spr_updated_at ON self_punch_requests;

DROP INDEX IF EXISTS idx_spr_created_at;
DROP INDEX IF EXISTS idx_spr_mobile;
DROP INDEX IF EXISTS idx_spr_status;
DROP INDEX IF EXISTS idx_spr_city_id;
DROP INDEX IF EXISTS idx_spr_zone_id;
DROP INDEX IF EXISTS idx_spr_ward_id;
DROP INDEX IF EXISTS uidx_spr_mobile_pending;

DROP TABLE IF EXISTS self_punch_requests;


-- ---------------------------------------------------------------------------
-- 1. ENUM types
--    NOTE: set_updated_at() is intentionally NOT dropped here because it
--    pre-existed in the RBAC migration and may still be in use.
-- ---------------------------------------------------------------------------
DROP TYPE IF EXISTS self_punch_actor_type;
DROP TYPE IF EXISTS self_punch_action;
DROP TYPE IF EXISTS self_punch_status;


-- ---------------------------------------------------------------------------
-- PRE-FLIGHT ROLLBACK (kothi_assignments PK)
--
-- ⚠️  UNCOMMENT ONLY if you are certain no other table has added a FK against
--     kothi_assignments.id since the UP migration ran, and no application code
--     depends on the PK existing.
--
-- ALTER TABLE kothi_assignments DROP CONSTRAINT IF EXISTS kothi_assignments_pkey;
-- ALTER TABLE kothi_assignments ALTER COLUMN id DROP NOT NULL;
-- ALTER TABLE kothi_assignments ALTER COLUMN id DROP DEFAULT;
-- DROP SEQUENCE IF EXISTS kothi_assignments_id_seq;
-- ---------------------------------------------------------------------------


COMMIT;
