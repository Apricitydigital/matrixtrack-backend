-- Rename the professional responsibility without losing employee/site assignments.
DO $$
DECLARE old_role RECORD; target_id INTEGER; fk RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('professional-department-designation'));
  FOR old_role IN SELECT d.designation_id,d.department_id FROM designation d JOIN department dep ON dep.department_id=d.department_id
    WHERE LOWER(TRIM(dep.department_name))='professional' AND LOWER(TRIM(d.designation_name))='country head'
    ORDER BY d.designation_id
  LOOP
    SELECT designation_id INTO target_id FROM designation WHERE department_id=old_role.department_id
      AND LOWER(TRIM(designation_name))='head of department' ORDER BY designation_id LIMIT 1;
    IF target_id IS NULL THEN
      UPDATE designation SET designation_name='Head of Department' WHERE designation_id=old_role.designation_id;
    ELSE
      IF to_regclass('professional_designation_assignments') IS NOT NULL THEN
        INSERT INTO professional_designation_assignments(professional_id,designation_id,assigned_by,assigned_at)
          SELECT professional_id,target_id,assigned_by,assigned_at FROM professional_designation_assignments WHERE designation_id=old_role.designation_id
          ON CONFLICT(professional_id,designation_id) DO NOTHING;
        DELETE FROM professional_designation_assignments WHERE designation_id=old_role.designation_id;
      END IF;
      -- Preserve other primary-designation references as well.
      FOR fk IN SELECT n.nspname AS schema_name,c.relname AS table_name,a.attname AS column_name
        FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=con.conkey[1]
        WHERE con.contype='f' AND con.confrelid='designation'::regclass AND array_length(con.conkey,1)=1
          AND c.oid<>COALESCE(to_regclass('professional_designation_assignments'),0::oid)
      LOOP
        EXECUTE format('UPDATE %I.%I SET %I=$1 WHERE %I=$2',fk.schema_name,fk.table_name,fk.column_name,fk.column_name)
          USING target_id,old_role.designation_id;
      END LOOP;
      DELETE FROM designation WHERE designation_id=old_role.designation_id;
    END IF;
  END LOOP;
END $$;
