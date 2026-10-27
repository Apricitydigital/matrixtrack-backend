ALTER TABLE employee ADD COLUMN IF NOT EXISTS no_personal_phone BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE employee ALTER COLUMN phone DROP NOT NULL;

CREATE TABLE IF NOT EXISTS register_attendance_requests (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 emp_id INTEGER NOT NULL REFERENCES employee(emp_id),
 site_id INTEGER NOT NULL REFERENCES wards(ward_id),
 requested_by UUID NOT NULL REFERENCES professional_employees(id),
 duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 30),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
 status TEXT NOT NULL DEFAULT 'pending_ho' CHECK(status IN ('pending_ho','pending_hod','approved','rejected')),
 ho_reviewer_id UUID REFERENCES professional_employees(id), ho_reviewed_at TIMESTAMPTZ, ho_note TEXT,
 hod_reviewer_id UUID REFERENCES professional_employees(id), hod_reviewed_at TIMESTAMPTZ, hod_note TEXT,
 starts_on DATE, ends_on DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(status <> 'approved' OR (starts_on IS NOT NULL AND ends_on=starts_on+duration_days-1 AND ho_reviewer_id IS NOT NULL AND hod_reviewer_id IS NOT NULL)),
 CHECK(ho_reviewer_id IS NULL OR ho_reviewer_id <> requested_by),
 CHECK(hod_reviewer_id IS NULL OR (hod_reviewer_id <> requested_by AND hod_reviewer_id <> ho_reviewer_id))
);
CREATE INDEX IF NOT EXISTS register_attendance_requests_employee ON register_attendance_requests(emp_id,status,ends_on);
CREATE INDEX IF NOT EXISTS register_attendance_requests_scope ON register_attendance_requests(site_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS register_attendance_audit (
 id BIGSERIAL PRIMARY KEY, request_id UUID NOT NULL REFERENCES register_attendance_requests(id),
 actor_id UUID NOT NULL REFERENCES professional_employees(id), action TEXT NOT NULL,
 before_record JSONB, after_record JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS register_status TEXT CHECK(register_status IN ('present','absent'));
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS register_request_id UUID REFERENCES register_attendance_requests(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS register_marked_by UUID REFERENCES professional_employees(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS register_marked_at TIMESTAMPTZ;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS register_marked_by_name TEXT;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='attendance_register_evidence' AND conrelid='attendance'::regclass) THEN
  ALTER TABLE attendance ADD CONSTRAINT attendance_register_evidence CHECK(register_status IS NULL OR
   (register_request_id IS NOT NULL AND register_marked_by IS NOT NULL AND register_marked_at IS NOT NULL
    AND punch_in_time IS NULL AND punch_out_time IS NULL AND mid_shift_punch_in_time IS NULL AND leave_type IS NULL));
 END IF;
END $$;
