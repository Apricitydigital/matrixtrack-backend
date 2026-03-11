-- Add leave support to attendance
ALTER TABLE attendance
ADD COLUMN IF NOT EXISTS leave_type VARCHAR(16) CHECK (leave_type IN ('CASUAL','MEDICAL')),
ADD COLUMN IF NOT EXISTS leave_marked_by INT,
ADD COLUMN IF NOT EXISTS leave_marked_at TIMESTAMPTZ;

-- Optional index to speed lookups by date/emp
CREATE INDEX IF NOT EXISTS idx_attendance_leave_date_emp
  ON attendance (emp_id, date, leave_type);
