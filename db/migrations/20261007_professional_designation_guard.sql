-- Dedicated labels: never rename the shared REG PICKER/MRF records.
DO $$
DECLARE professional_department_id INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('professional-department-designation'));
  SELECT department_id INTO professional_department_id FROM department
    WHERE LOWER(TRIM(department_name)) = 'professional' ORDER BY department_id LIMIT 1;
  IF professional_department_id IS NULL THEN
    INSERT INTO department (department_name) VALUES ('Professional') RETURNING department_id INTO professional_department_id;
  ELSE
    UPDATE department SET department_name = 'Professional'
      WHERE department_id = professional_department_id AND department_name IS DISTINCT FROM 'Professional';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM designation WHERE department_id = professional_department_id
    AND LOWER(TRIM(designation_name)) = 'professional') THEN
    INSERT INTO designation (designation_name, department_id) VALUES ('Professional', professional_department_id);
  ELSE
    UPDATE designation SET designation_name = 'Professional'
      WHERE department_id = professional_department_id AND LOWER(TRIM(designation_name)) = 'professional'
        AND designation_name IS DISTINCT FROM 'Professional';
  END IF;
END $$;

-- Keeps legacy approval clients correct too.
CREATE OR REPLACE FUNCTION enforce_professional_employee_designation()
RETURNS TRIGGER AS $$
DECLARE professional_designation_id INTEGER;
BEGIN
  IF NEW.self_attendance_enabled IS TRUE OR EXISTS (
    SELECT 1 FROM professional_employees pe
    WHERE NULLIF(TRIM(pe.emp_code), '') = NEW.emp_code
      OR (NEW.emp_code = 'EMP-' || CASE WHEN NULLIF(pe.mobile, '') IS NOT NULL
        THEN RIGHT(pe.mobile, 6) ELSE LEFT(pe.id::text, 8) END
        AND NULLIF(TRIM(pe.emp_code), '') IS NULL)
  ) THEN
    SELECT d.designation_id INTO professional_designation_id
    FROM designation d JOIN department dep ON dep.department_id = d.department_id
    WHERE d.designation_name = 'Professional' AND dep.department_name = 'Professional'
    ORDER BY d.designation_id LIMIT 1;
    IF professional_designation_id IS NULL THEN
      RAISE EXCEPTION 'Professional department/designation mapping is missing';
    END IF;
    NEW.designation_id := professional_designation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_professional_employee_designation ON employee;
CREATE TRIGGER trg_professional_employee_designation
BEFORE INSERT OR UPDATE OF designation_id, self_attendance_enabled ON employee
FOR EACH ROW EXECUTE FUNCTION enforce_professional_employee_designation();
