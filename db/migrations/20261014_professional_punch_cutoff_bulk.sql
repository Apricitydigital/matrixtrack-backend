-- Admin and professional actors share the cutoff audit trail.
ALTER TABLE professional_punch_cutoffs ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE professional_punch_cutoffs ADD COLUMN IF NOT EXISTS updated_by_user INTEGER REFERENCES users(user_id);
ALTER TABLE professional_punch_activity ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE professional_punch_activity ADD COLUMN IF NOT EXISTS actor_user_id INTEGER REFERENCES users(user_id);
INSERT INTO permissions(module,action)
SELECT 'professional-punch-time',candidate.action FROM UNNEST(ARRAY['view','write']) AS candidate(action)
WHERE NOT EXISTS(SELECT 1 FROM permissions p WHERE p.module='professional-punch-time' AND p.action=candidate.action);
