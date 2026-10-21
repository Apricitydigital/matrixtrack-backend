-- Attendance access is separate from account activation and historical attendance.
CREATE TABLE IF NOT EXISTS professional_attendance_blocks (
  professional_id UUID PRIMARY KEY REFERENCES professional_employees(id) ON DELETE CASCADE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NOT NULL,
  updated_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS professional_attendance_block_history (
  id BIGSERIAL PRIMARY KEY,
  professional_id UUID NOT NULL,
  related_profile_ids UUID[] NOT NULL,
  is_blocked BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS professional_attendance_block_history_employee_idx
  ON professional_attendance_block_history(professional_id, id DESC);
INSERT INTO permissions(module,action)
SELECT 'professional-employee-block',candidate FROM UNNEST(ARRAY['view','write']) candidate
WHERE NOT EXISTS(SELECT 1 FROM permissions p WHERE p.module='professional-employee-block' AND p.action=candidate);
