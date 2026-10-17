INSERT INTO permissions(module,action)
SELECT 'professional-holiday-declare',candidate FROM UNNEST(ARRAY['view','write']) candidate
WHERE NOT EXISTS(SELECT 1 FROM permissions p WHERE p.module='professional-holiday-declare' AND p.action=candidate);
