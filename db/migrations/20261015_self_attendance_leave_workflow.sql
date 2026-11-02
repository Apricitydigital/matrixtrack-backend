ALTER TABLE self_attendance_leave_requests
  ADD COLUMN IF NOT EXISTS approval_stage TEXT NOT NULL DEFAULT 'pending_pm',
  ADD COLUMN IF NOT EXISTS pm_reviewer_id UUID REFERENCES self_attendance_employees(id),
  ADD COLUMN IF NOT EXISTS pm_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pm_note TEXT,
  ADD COLUMN IF NOT EXISTS ho_reviewer_id UUID REFERENCES self_attendance_employees(id),
  ADD COLUMN IF NOT EXISTS ho_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ho_note TEXT;
UPDATE self_attendance_leave_requests SET approval_stage=CASE WHEN status='approved' THEN 'accepted' ELSE 'rejected' END
  WHERE status IN ('approved','rejected') AND approval_stage='pending_pm';
ALTER TABLE self_attendance_leave_request_logs
  ADD COLUMN IF NOT EXISTS old_values JSONB,
  ADD COLUMN IF NOT EXISTS new_values JSONB;
CREATE INDEX IF NOT EXISTS self_attendance_leave_pending_stage ON self_attendance_leave_requests(approval_stage,requested_date);
