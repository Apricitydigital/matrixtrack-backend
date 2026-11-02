-- Pending/rejected attempts must never count as a confirmed punch-in.
ALTER TABLE self_attendance_records ALTER COLUMN punch_in DROP NOT NULL;
ALTER TABLE self_attendance_records
  ADD COLUMN IF NOT EXISTS attempted_punch_in TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS punch_approval_status TEXT NOT NULL DEFAULT 'accepted',
  ADD COLUMN IF NOT EXISTS punch_cutoff TIME;
CREATE TABLE IF NOT EXISTS self_attendance_punch_cutoffs (
  self_attendance_id UUID PRIMARY KEY REFERENCES self_attendance_employees(id),
  cutoff_time TIME NOT NULL,
  updated_by UUID NOT NULL REFERENCES self_attendance_employees(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS self_attendance_punch_activity (
  id BIGSERIAL PRIMARY KEY,
  self_attendance_id UUID NOT NULL REFERENCES self_attendance_employees(id),
  attendance_date DATE,
  actor_id UUID NOT NULL REFERENCES self_attendance_employees(id),
  action TEXT NOT NULL,
  old_time TIME,
  new_time TIME,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS self_attendance_punch_activity_employee ON self_attendance_punch_activity(self_attendance_id,id DESC);
CREATE INDEX IF NOT EXISTS self_attendance_punch_pending ON self_attendance_records(punch_approval_status,date);
CREATE TABLE IF NOT EXISTS self_attendance_punch_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by INTEGER REFERENCES users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO self_attendance_punch_settings(id,enabled) VALUES(1,FALSE) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS self_attendance_punch_setting_history (
  id BIGSERIAL PRIMARY KEY,
  old_enabled BOOLEAN NOT NULL,
  enabled BOOLEAN NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
