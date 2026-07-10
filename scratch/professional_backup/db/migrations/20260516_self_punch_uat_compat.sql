-- =============================================================================
-- MIGRATION: Self Punch UAT Compatibility
-- Purpose  : Make legacy/UAT schemas compatible with current self-punch APIs.
-- Safe     : Additive only (no drops/deletes).
-- =============================================================================

BEGIN;

-- 1) Ensure emp_code exists where current code writes it.
ALTER TABLE IF EXISTS self_punch_requests
  ADD COLUMN IF NOT EXISTS emp_code VARCHAR(50);

ALTER TABLE IF EXISTS professional_employees
  ADD COLUMN IF NOT EXISTS emp_code VARCHAR(50);

-- 2) Ensure one active pending request per mobile (matches API behavior).
CREATE UNIQUE INDEX IF NOT EXISTS uidx_spr_mobile_pending
  ON self_punch_requests (mobile)
  WHERE status = 'pending';

-- 3) Ensure actor enum has required values used by API logs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'self_punch_actor_type') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'self_punch_actor_type' AND e.enumlabel = 'admin'
    ) THEN
      BEGIN
        ALTER TYPE self_punch_actor_type ADD VALUE 'admin';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
        WHEN OTHERS THEN
          RAISE NOTICE 'Skipping add enum value admin: %', SQLERRM;
      END;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'self_punch_actor_type' AND e.enumlabel = 'supervisor'
    ) THEN
      BEGIN
        ALTER TYPE self_punch_actor_type ADD VALUE 'supervisor';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
        WHEN OTHERS THEN
          RAISE NOTICE 'Skipping add enum value supervisor: %', SQLERRM;
      END;
    END IF;
  END IF;
END $$;

COMMIT;
