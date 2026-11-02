INSERT INTO permissions(module,action)
SELECT 'self-attendance-holiday-declare',candidate FROM UNNEST(ARRAY['view','write']) candidate
WHERE NOT EXISTS(SELECT 1 FROM permissions p WHERE p.module='self-attendance-holiday-declare' AND p.action=candidate);
