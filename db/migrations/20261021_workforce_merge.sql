CREATE TABLE IF NOT EXISTS workforce_employee_aliases (
 employee_kind TEXT NOT NULL CHECK(employee_kind IN ('regular','professional')),
 source_id TEXT NOT NULL, target_id TEXT NOT NULL, emp_code TEXT, face_id TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(employee_kind,source_id),
 CHECK(source_id<>target_id)
);
CREATE INDEX IF NOT EXISTS workforce_alias_target ON workforce_employee_aliases(employee_kind,target_id);
-- Kept separate from public employee-ID redirects. Only authentication reads
-- these hashes; admin previews never return them. Main-password rotation makes
-- retired passwords invalid without changing the main account's credentials.
CREATE TABLE IF NOT EXISTS workforce_professional_login_aliases (
 source_id TEXT PRIMARY KEY,target_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE RESTRICT,
 email TEXT,mobile TEXT,mobile_normalized TEXT,password_hash TEXT,main_password_hash TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workforce_login_alias_target ON workforce_professional_login_aliases(target_id);
CREATE INDEX IF NOT EXISTS workforce_login_alias_email ON workforce_professional_login_aliases(email);
CREATE INDEX IF NOT EXISTS workforce_login_alias_mobile ON workforce_professional_login_aliases(mobile_normalized);
CREATE TABLE IF NOT EXISTS workforce_merge_audit (
 id BIGSERIAL PRIMARY KEY, employee_kind TEXT NOT NULL, target_id TEXT NOT NULL,
 source_ids TEXT[] NOT NULL, actor_user_id INTEGER NOT NULL, reason TEXT NOT NULL,
 profile_snapshots JSONB NOT NULL, affected_rows JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE workforce_merge_audit ADD COLUMN IF NOT EXISTS attendance_snapshots JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Redirect delayed/background writes that still carry a removed employee ID.
-- Installed only on the reference columns discovered by a confirmed merge.
CREATE OR REPLACE FUNCTION workforce_redirect_employee_reference() RETURNS TRIGGER AS $$
DECLARE destination TEXT;
BEGIN
 SELECT target_id INTO destination FROM workforce_employee_aliases
 WHERE employee_kind=TG_ARGV[0] AND source_id=to_jsonb(NEW)->>TG_ARGV[1];
 IF destination IS NOT NULL THEN
  NEW:=jsonb_populate_record(NEW,jsonb_build_object(TG_ARGV[1],destination));
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
