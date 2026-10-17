ALTER TABLE professional_leave_requests ADD COLUMN IF NOT EXISTS auto_rejected_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS professional_leave_expiry_pending ON professional_leave_requests(requested_date) WHERE status='pending';

CREATE OR REPLACE FUNCTION professional_expire_pending_leaves(as_of DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
RETURNS INTEGER LANGUAGE sql AS $$
  WITH overdue AS MATERIALIZED (
    SELECT l.* FROM professional_leave_requests l
    WHERE l.status='pending' AND l.requested_date<as_of
    ORDER BY l.id FOR UPDATE
  ), expired AS (
    UPDATE professional_leave_requests l SET status='rejected',approval_stage='rejected',
      auto_rejected_at=NOW(),reviewed_at=NOW(),
      review_note='Automatically rejected: leave date passed before final approval (IST).'
    FROM overdue o WHERE l.id=o.id AND l.status='pending'
    RETURNING l.*
  ), history AS (
    INSERT INTO professional_leave_request_logs(request_id,action,actor_type,note,old_values,new_values)
    SELECT e.id,'rejected','system',e.review_note,to_jsonb(o),to_jsonb(e)
    FROM expired e JOIN overdue o ON o.id=e.id
  ), notifications AS (
    INSERT INTO professional_notifications(professional_id,type,title,message,metadata)
    SELECT e.professional_id,'leave-review','Leave automatically rejected',
      'Your leave request for ' || e.requested_date::text || ' was automatically rejected because the date passed before final approval.',
      jsonb_build_object('request_id',e.id,'stage','rejected','automatic',true)
    FROM expired e
  ) SELECT COUNT(*)::int FROM expired;
$$;
