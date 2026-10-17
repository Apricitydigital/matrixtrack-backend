ALTER TABLE professional_leave_requests
  ADD COLUMN IF NOT EXISTS approval_route TEXT NOT NULL DEFAULT 'pm_ho',
  ADD COLUMN IF NOT EXISTS hod_reviewer_id UUID REFERENCES professional_employees(id),
  ADD COLUMN IF NOT EXISTS hod_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hod_note TEXT;
-- Keep existing decisions/history; redirect unresolved HO requests to HOD.
WITH before AS MATERIALIZED (
  SELECT l.* FROM professional_leave_requests l
  WHERE l.status='pending' AND l.approval_stage IN ('pending_pm','pending_ho')
  AND EXISTS(SELECT 1 FROM professional_designation_assignments a JOIN designation d ON d.designation_id=a.designation_id
    WHERE a.professional_id=l.professional_id AND d.designation_name='HO Coordinator') FOR UPDATE
), changed AS (
  UPDATE professional_leave_requests l SET approval_route='hod',approval_stage='pending_hod'
  FROM before b WHERE l.id=b.id RETURNING l.*
)
INSERT INTO professional_leave_request_logs(request_id,action,actor_type,note,old_values,new_values)
SELECT c.id,'submitted','system','Automatically routed HO Coordinator request to Head of Department.',to_jsonb(b),to_jsonb(c)
FROM changed c JOIN before b ON b.id=c.id;
