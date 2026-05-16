-- =============================================================================
-- MIGRATION: Self Punch-In Feature (UP)
-- Version   : 20260505_self_punch_in_up.sql
-- Feature   : Unregistered field workers can request access, get approved by
--             supervisors, then punch in/out daily as "professional employees".
-- Run with  : psql -h <host> -U <user> -d <db> -f 20260505_self_punch_in_up.sql
-- Rollback  : 20260505_self_punch_in_down.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT: kothi_assignments has no PK or UNIQUE constraint in production.
-- We must add one before any FK can reference it.
-- Steps are guarded so re-running is safe:
--   1. Set id NOT NULL (required for a PK column).
--   2. Deduplicate any existing rows with the same id (safety net).
--   3. Add PRIMARY KEY constraint.
-- ---------------------------------------------------------------------------

-- 1a. Make id NOT NULL (skip if already set)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kothi_assignments'
      AND column_name = 'id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE kothi_assignments ALTER COLUMN id SET NOT NULL;
    RAISE NOTICE 'kothi_assignments.id set to NOT NULL';
  END IF;
END$$;

-- 1b. Remove duplicate ids so we can safely add a PK
--     Keeps the row with the smallest ctid (physical row order).
DELETE FROM kothi_assignments a
USING (
  SELECT id, MIN(ctid) AS keep_ctid
  FROM kothi_assignments
  WHERE id IS NOT NULL
  GROUP BY id
  HAVING COUNT(*) > 1
) dups
WHERE a.id = dups.id
  AND a.ctid <> dups.keep_ctid;

-- 1c. Add sequence-based default if column has none (avoids manual id inserts)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name  = 'kothi_assignments'
      AND column_name = 'id'
      AND column_default IS NOT NULL
  ) THEN
    CREATE SEQUENCE IF NOT EXISTS kothi_assignments_id_seq;
    ALTER TABLE kothi_assignments
      ALTER COLUMN id SET DEFAULT nextval('kothi_assignments_id_seq');
    -- Sync sequence to current max id so next insert doesn't collide
    PERFORM setval(
      'kothi_assignments_id_seq',
      COALESCE((SELECT MAX(id) FROM kothi_assignments), 0) + 1,
      false
    );
    RAISE NOTICE 'kothi_assignments_id_seq created and synced';
  END IF;
END$$;

-- 1d. Add PRIMARY KEY (idempotent guard)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name      = 'kothi_assignments'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE kothi_assignments ADD PRIMARY KEY (id);
    RAISE NOTICE 'kothi_assignments PRIMARY KEY added';
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 0. SHARED TRIGGER FUNCTION
--    CREATE OR REPLACE is safe — won't break if it already exists from RBAC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------------
-- 1. ENUM TYPES
--    DO $$ guards make each statement idempotent.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'self_punch_status') THEN
    CREATE TYPE self_punch_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'self_punch_action') THEN
    CREATE TYPE self_punch_action AS ENUM ('submitted', 'approved', 'rejected', 'viewed');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'self_punch_actor_type') THEN
    CREATE TYPE self_punch_actor_type AS ENUM ('supervisor', 'admin');
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 2. TABLE: self_punch_requests
--    Root table for the Self Punch-In workflow.
--    Stores every onboarding request submitted by an unregistered field worker.
--
--    Security notes:
--      • aadhar_number   → store AES-256-GCM ciphertext from the app layer.
--      • aadhar_doc_url  → S3/B2 object KEY only (not a signed URL).
--        Resolve to a short-lived signed URL at read time.
--      • selfie_url      → same pattern; used to seed biometric face matching.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS self_punch_requests (
  id               UUID                PRIMARY KEY DEFAULT gen_random_uuid(),

  full_name        VARCHAR(200)        NOT NULL,
  mobile           VARCHAR(15)         NOT NULL,
  email            VARCHAR(254),

  -- PII stored as application-level encrypted ciphertext (AES-256-GCM)
  aadhar_number    VARCHAR(512)        NOT NULL,

  -- S3/B2 object keys — resolve to signed URLs at read time, never store full URLs
  aadhar_doc_url   VARCHAR(1024)       NOT NULL,   -- PDF or image of Aadhar card
  selfie_url       VARCHAR(1024)       NOT NULL,   -- Face photo for biometric seed

  -- Geographic scope chosen by the worker during registration
  city_id          INTEGER             NOT NULL REFERENCES cities(city_id)       ON DELETE RESTRICT,
  zone_id          INTEGER             NOT NULL REFERENCES zones(zone_id)        ON DELETE RESTRICT,
  ward_id          INTEGER             NOT NULL REFERENCES wards(ward_id)        ON DELETE RESTRICT,
  kothi_id         INTEGER                      REFERENCES kothi_assignments(id) ON DELETE SET NULL,

  status           self_punch_status   NOT NULL DEFAULT 'pending',

  created_at       TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

-- One active (pending) request per mobile number at a time
CREATE UNIQUE INDEX IF NOT EXISTS uidx_spr_mobile_pending
  ON self_punch_requests (mobile)
  WHERE status = 'pending';

-- Supervisor dashboard: filter pending requests by geography
CREATE INDEX IF NOT EXISTS idx_spr_ward_id    ON self_punch_requests (ward_id);
CREATE INDEX IF NOT EXISTS idx_spr_zone_id    ON self_punch_requests (zone_id);
CREATE INDEX IF NOT EXISTS idx_spr_city_id    ON self_punch_requests (city_id);
CREATE INDEX IF NOT EXISTS idx_spr_status     ON self_punch_requests (status);
-- Re-submission lookup (mobile search)
CREATE INDEX IF NOT EXISTS idx_spr_mobile     ON self_punch_requests (mobile);
-- Admin list view sorted by newest first
CREATE INDEX IF NOT EXISTS idx_spr_created_at ON self_punch_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spr_ward_status ON self_punch_requests(ward_id, status);
CREATE INDEX IF NOT EXISTS idx_spr_kothi_status ON self_punch_requests(kothi_id, status);

DROP TRIGGER IF EXISTS trg_spr_updated_at ON self_punch_requests;
CREATE TRIGGER trg_spr_updated_at
BEFORE UPDATE ON self_punch_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  self_punch_requests               IS 'Onboarding requests by unregistered field workers seeking self punch-in access.';
COMMENT ON COLUMN self_punch_requests.aadhar_number IS 'Application-layer encrypted Aadhar ciphertext. Algorithm: AES-256-GCM. Never store plaintext.';
COMMENT ON COLUMN self_punch_requests.aadhar_doc_url IS 'S3/B2 object key for Aadhar document. Resolve to signed URL at read time.';
COMMENT ON COLUMN self_punch_requests.selfie_url    IS 'S3/B2 object key for the biometric selfie photo. Used to seed face recognition.';
COMMENT ON COLUMN self_punch_requests.kothi_id      IS 'Optional kothi_assignments.id. NULL = ward-level assignment only.';


-- ---------------------------------------------------------------------------
-- 3. TABLE: self_punch_request_logs
--    Append-only audit trail for every lifecycle event on a request.
--    Rows must NEVER be updated or deleted (enforced by application layer;
--    a RULE or RLS policy can add DB-level enforcement if needed later).
--
--    performed_by_id is intentionally untyped (INT) because it can reference
--    either supervisors.supervisor_id or users.user_id depending on
--    performed_by_type (polymorphic relationship — no DB-level FK).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS self_punch_request_logs (
  id                UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        UUID                  NOT NULL REFERENCES self_punch_requests(id) ON DELETE CASCADE,

  action            self_punch_action     NOT NULL,

  -- Polymorphic actor reference
  performed_by_type self_punch_actor_type NOT NULL,
  performed_by_id   INTEGER               NOT NULL,   -- supervisor_id OR admin user_id

  note              TEXT,                             -- Rejection reason / approval note

  created_at        TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);

-- Most common query: all log entries for a single request
CREATE INDEX IF NOT EXISTS idx_sprl_request_id ON self_punch_request_logs (request_id);
-- Audit trail: all actions by a specific supervisor/admin
CREATE INDEX IF NOT EXISTS idx_sprl_actor      ON self_punch_request_logs (performed_by_type, performed_by_id);
CREATE INDEX IF NOT EXISTS idx_sprl_created_at ON self_punch_request_logs (created_at DESC);

COMMENT ON TABLE  self_punch_request_logs                  IS 'Immutable audit log of all actions on self_punch_requests. Append-only — never update or delete rows.';
COMMENT ON COLUMN self_punch_request_logs.performed_by_id  IS 'supervisors.supervisor_id when type=supervisor; users.user_id when type=admin. No FK enforced (polymorphic).';


-- ---------------------------------------------------------------------------
-- 4. TABLE: professional_employees
--    Created exactly once per approved self_punch_request.
--    selfie_url is biometrically locked — a DB trigger rejects any attempt to
--    overwrite it when face_locked = TRUE.
--
--    Personal details are snapshotted from the request at approval time so the
--    audit record remains stable even if the source request data were changed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS professional_employees (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 1-to-1 back-reference; ON DELETE RESTRICT prevents orphaning a pro_employee
  request_id       UUID          NOT NULL UNIQUE REFERENCES self_punch_requests(id) ON DELETE RESTRICT,

  -- Snapshot from the approved request (denormalized for audit stability)
  full_name        VARCHAR(200)  NOT NULL,
  mobile           VARCHAR(15)   NOT NULL,
  email            VARCHAR(254),
  password_hash    VARCHAR(255)  NOT NULL,
  aadhar_number    VARCHAR(512)  NOT NULL,   -- Encrypted ciphertext

  aadhar_doc_url   VARCHAR(1024) NOT NULL,
  selfie_url       VARCHAR(1024) NOT NULL,   -- LOCKED after approval

  -- Geographic assignment (copied from approved request)
  city_id          INTEGER       NOT NULL REFERENCES cities(city_id)       ON DELETE RESTRICT,
  zone_id          INTEGER       NOT NULL REFERENCES zones(zone_id)        ON DELETE RESTRICT,
  ward_id          INTEGER       NOT NULL REFERENCES wards(ward_id)        ON DELETE RESTRICT,
  kothi_id         INTEGER                REFERENCES kothi_assignments(id) ON DELETE SET NULL,

  face_locked      BOOLEAN       NOT NULL DEFAULT TRUE,   -- TRUE = selfie immutable
  is_active        BOOLEAN       NOT NULL DEFAULT TRUE,

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- No updated_at intentionally: row is immutable post-approval.
  -- Status changes are tracked in self_punch_request_logs.
);

-- Dashboard filters: by geography and active status
CREATE INDEX IF NOT EXISTS idx_pe_ward_id   ON professional_employees (ward_id);
CREATE INDEX IF NOT EXISTS idx_pe_zone_id   ON professional_employees (zone_id);
CREATE INDEX IF NOT EXISTS idx_pe_city_id   ON professional_employees (city_id);
CREATE INDEX IF NOT EXISTS idx_pe_mobile    ON professional_employees (mobile);
CREATE INDEX IF NOT EXISTS idx_pe_is_active ON professional_employees (is_active);

-- DB-level enforcement: block selfie_url overwrites when face is locked
CREATE OR REPLACE FUNCTION prevent_selfie_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.face_locked = TRUE AND NEW.selfie_url IS DISTINCT FROM OLD.selfie_url THEN
    RAISE EXCEPTION
      'selfie_url is locked for professional_employee id=%. Biometric update rejected. '
      'Unlock face_locked first via a supervisor-approved re-verification workflow.',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pe_lock_selfie ON professional_employees;
CREATE TRIGGER trg_pe_lock_selfie
BEFORE UPDATE ON professional_employees
FOR EACH ROW EXECUTE FUNCTION prevent_selfie_update();

COMMENT ON TABLE  professional_employees             IS 'Approved field workers eligible for self punch-in. One row per approved self_punch_request.';
COMMENT ON COLUMN professional_employees.face_locked IS 'TRUE = selfie_url immutable. Enforced by trg_pe_lock_selfie trigger AND application layer.';
COMMENT ON COLUMN professional_employees.selfie_url  IS 'Locked S3/B2 object key for biometric selfie. Used for daily face-match during punch-in.';
COMMENT ON COLUMN professional_employees.request_id  IS 'UNIQUE FK back to self_punch_requests. ON DELETE RESTRICT prevents orphan records.';


-- ---------------------------------------------------------------------------
-- 5. TABLE: professional_attendance
--    One row per (professional_employee, calendar date).
--    Geographic columns are denormalized for fast dashboard aggregation without
--    joining professional_employees on every query.
--
--    Punch-out starts as NULL and is populated by:
--      a) The worker's own manual punch-out via the app.
--      b) The existing auto-punchout scheduler (adapted for this table).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS professional_attendance (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_id  UUID          NOT NULL REFERENCES professional_employees(id) ON DELETE RESTRICT,

  date             DATE          NOT NULL,
  punch_in         TIMESTAMPTZ   NOT NULL,
  punch_out        TIMESTAMPTZ,             -- NULL while still punched in

  -- Denormalized geography — eliminates join on professional_employees for reports
  ward_id          INTEGER       NOT NULL REFERENCES wards(ward_id)  ON DELETE RESTRICT,
  zone_id          INTEGER       NOT NULL REFERENCES zones(zone_id)  ON DELETE RESTRICT,
  city_id          INTEGER       NOT NULL REFERENCES cities(city_id) ON DELETE RESTRICT,

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- One record per professional per calendar day
  CONSTRAINT uq_pa_professional_date UNIQUE (professional_id, date),
  -- Punch-out must be after punch-in (or NULL)
  CONSTRAINT chk_pa_punch_order      CHECK  (punch_out IS NULL OR punch_out >= punch_in)
);

-- Full history for one professional (profile page, monthly report)
CREATE INDEX IF NOT EXISTS idx_pa_professional_id ON professional_attendance (professional_id);
-- Date-range scans for daily/weekly/monthly dashboards
CREATE INDEX IF NOT EXISTS idx_pa_date            ON professional_attendance (date DESC);
-- Geography filters for supervisor ward/zone dashboards
CREATE INDEX IF NOT EXISTS idx_pa_ward_id         ON professional_attendance (ward_id);
CREATE INDEX IF NOT EXISTS idx_pa_zone_id         ON professional_attendance (zone_id);
CREATE INDEX IF NOT EXISTS idx_pa_city_id         ON professional_attendance (city_id);
-- "Who is present today in ward X?" — compound index for this exact pattern
CREATE INDEX IF NOT EXISTS idx_pa_ward_date       ON professional_attendance (ward_id, date DESC);
-- Auto-punchout scheduler: fast scan of open (still punched in) records
CREATE INDEX IF NOT EXISTS idx_pa_open_punches    ON professional_attendance (date) WHERE punch_out IS NULL;

COMMENT ON TABLE  professional_attendance              IS 'Daily punch-in/out records for approved professional field workers.';
COMMENT ON COLUMN professional_attendance.punch_out    IS 'NULL while worker is active. Filled by manual punch-out or the auto-punchout scheduler.';
COMMENT ON COLUMN professional_attendance.ward_id      IS 'Denormalized from professional_employees. Avoids join overhead on dashboard queries.';


COMMIT;
