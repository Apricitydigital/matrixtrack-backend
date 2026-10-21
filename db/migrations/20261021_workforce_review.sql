CREATE TABLE IF NOT EXISTS workforce_review_issues (
 id BIGSERIAL PRIMARY KEY, employee_kind TEXT NOT NULL CHECK(employee_kind IN ('regular','professional')),
 employee_id TEXT NOT NULL, employee_name TEXT NOT NULL, reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','done','dismissed')),
 created_by INTEGER, updated_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS workforce_deletion_audit (
 id BIGSERIAL PRIMARY KEY, employee_kind TEXT NOT NULL, employee_id TEXT NOT NULL,
 employee_name TEXT NOT NULL, reason TEXT NOT NULL, actor_user_id INTEGER NOT NULL,
 affected_rows JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
