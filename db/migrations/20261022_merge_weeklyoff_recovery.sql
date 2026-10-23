-- Preserve the existing weekly-off history implementation, adding only a guard
-- for inverse replay. Restoring historical snapshots must not append a new
-- schedule that silently changes historical payroll.
DO $$
DECLARE definition TEXT;
BEGIN
 IF to_regprocedure('capture_professional_week_off()') IS NOT NULL THEN
  SELECT pg_get_functiondef(to_regprocedure('capture_professional_week_off()')) INTO definition;
  IF position('matrixtrack.merge_replay' IN definition)=0 THEN
   IF definition !~* '\mBEGIN\M' THEN RAISE EXCEPTION 'Weekly-off history function requires manual recovery upgrade'; END IF;
   definition:=regexp_replace(definition,'\mBEGIN\M',E'BEGIN\n IF current_setting(''matrixtrack.merge_replay'',true)=''on'' THEN RETURN NEW; END IF;','i');
   EXECUTE definition;
  END IF;
 END IF;
END;
$$;
