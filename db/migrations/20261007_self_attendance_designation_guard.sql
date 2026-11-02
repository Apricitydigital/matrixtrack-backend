-- Dedicated labels: never rename the shared REG PICKER/MRF records.
DO $$
DECLARE self_attendance_department_id INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('self-attendance-department-designation'));
  SELECT department_id INTO self_attendance_department_id FROM department
    WHERE LOWER(TRIM(department_name)) = 'self attendance' ORDER BY department_id LIMIT 1;
  IF self_attendance_department_id IS NULL THEN
    INSERT INTO department (department_name) VALUES ('Self Attendance') RETURNING department_id INTO self_attendance_department_id;
  ELSE
    UPDATE department SET department_name = 'Self Attendance'
      WHERE department_id = self_attendance_department_id AND department_name IS DISTINCT FROM 'Self Attendance';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM designation WHERE department_id = self_attendance_department_id
    AND LOWER(TRIM(designation_name)) = 'self attendance') THEN
    INSERT INTO designation (designation_name, department_id) VALUES ('Self Attendance', self_attendance_department_id);
  ELSE
    UPDATE designation SET designation_name = 'Self Attendance'
      WHERE department_id = self_attendance_department_id AND LOWER(TRIM(designation_name)) = 'self attendance'
        AND designation_name IS DISTINCT FROM 'Self Attendance';
  END IF;
END $$;

-- Keeps legacy approval clients correct too.
CREATE OR REPLACE FUNCTION enforce_self_attendance_employee_designation()
RETURNS TRIGGER AS $$
DECLARE self_attendance_designation_id INTEGER;
BEGIN
  IF NEW.self_attendance_enabled IS TRUE OR EXISTS (
    SELECT 1 FROM self_attendance_employees pe
    WHERE NULLIF(TRIM(pe.emp_code), '') = NEW.emp_code
      OR (NEW.emp_code = 'EMP-' || CASE WHEN NULLIF(pe.mobile, '') IS NOT NULL
        THEN RIGHT(pe.mobile, 6) ELSE LEFT(pe.id::text, 8) END
        AND NULLIF(TRIM(pe.emp_code), '') IS NULL)
  ) THEN
    SELECT d.designation_id INTO self_attendance_designation_id
    FROM designation d JOIN department dep ON dep.department_id = d.department_id
    WHERE d.designation_name = 'Self Attendance' AND dep.department_name = 'Self Attendance'
    ORDER BY d.designation_id LIMIT 1;
    IF self_attendance_designation_id IS NULL THEN
      RAISE EXCEPTION 'Self Attendance department/designation mapping is missing';
    END IF;
    NEW.designation_id := self_attendance_designation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_self_attendance_employee_designation ON employee;
CREATE TRIGGER trg_self_attendance_employee_designation
BEFORE INSERT OR UPDATE OF designation_id, self_attendance_enabled ON employee
FOR EACH ROW EXECUTE FUNCTION enforce_self_attendance_employee_designation();
