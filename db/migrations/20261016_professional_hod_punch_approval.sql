-- System routing events have no human actor. Human review endpoints still set actor_id.
ALTER TABLE professional_punch_activity ALTER COLUMN actor_id DROP NOT NULL;
WITH changed AS (
UPDATE professional_attendance p SET punch_approval_status='pending_hod'
WHERE p.punch_approval_status IN ('pending_pm','pending_ho')
AND EXISTS(SELECT 1 FROM professional_designation_assignments a JOIN designation d ON d.designation_id=a.designation_id
  WHERE a.professional_id=p.professional_id AND d.designation_name='HO Coordinator')
RETURNING p.professional_id,p.date
)
INSERT INTO professional_punch_activity(professional_id,attendance_date,action,note)
SELECT professional_id,date,'route_to_hod','Automatically routed HO Coordinator late punch-in to Head of Department.' FROM changed;
