-- Expand allowed leave types
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_leave_type_check;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_leave_type_check
  CHECK (leave_type IN (
    'ABSENT',
    'LOP',
    'EL',
    'SLML',
    'CL',
    'COMP_OFF',
    'OUT_DUTY',
    'WEEKLY_OFF',
    'CASUAL',
    'MEDICAL'
  ));
