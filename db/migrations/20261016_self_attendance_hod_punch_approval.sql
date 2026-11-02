-- System routing events have no human actor. Human review endpoints still set actor_id.
ALTER TABLE self_attendance_punch_activity ALTER COLUMN actor_id DROP NOT NULL;
WITH changed AS (
UPDATE self_attendance_records p SET punch_approval_status='pending_hod'
WHERE p.punch_approval_status IN ('pending_pm','pending_ho')
AND EXISTS(SELECT 1 FROM self_attendance_designation_assignments a JOIN designation d ON d.designation_id=a.designation_id
  WHERE a.self_attendance_id=p.self_attendance_id AND d.designation_name='HO Coordinator')
RETURNING p.self_attendance_id,p.date
)
INSERT INTO self_attendance_punch_activity(self_attendance_id,attendance_date,action,note)
SELECT self_attendance_id,date,'route_to_hod','Automatically routed HO Coordinator late punch-in to Head of Department.' FROM changed;
