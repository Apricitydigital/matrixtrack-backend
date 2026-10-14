-- Extra professional responsibilities are independent of the existing primary designation.
DO $$
DECLARE dep INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('professional-department-designation'));
  SELECT department_id INTO dep FROM department WHERE LOWER(TRIM(department_name)) = 'professional' ORDER BY department_id LIMIT 1;
  IF dep IS NULL THEN
    INSERT INTO department(department_name) VALUES ('Professional') RETURNING department_id INTO dep;
  END IF;
  INSERT INTO designation(designation_name, department_id)
  SELECT label, dep FROM UNNEST(ARRAY['Project Head / Site Head','HO Coordinator','Country Head']) label
  WHERE NOT EXISTS (SELECT 1 FROM designation d WHERE d.department_id = dep AND LOWER(TRIM(d.designation_name)) = LOWER(label));
END $$;

CREATE TABLE IF NOT EXISTS professional_designation_assignments (
  professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
  designation_id INTEGER NOT NULL REFERENCES designation(designation_id),
  assigned_by INTEGER REFERENCES users(user_id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(professional_id, designation_id)
);
CREATE TABLE IF NOT EXISTS professional_site_access (
  professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
  kothi_id INTEGER NOT NULL REFERENCES wards(ward_id),
  assigned_by INTEGER REFERENCES users(user_id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(professional_id, kothi_id)
);
ALTER TABLE professional_week_off ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date);
ALTER TABLE professional_week_off ADD COLUMN IF NOT EXISTS updated_by_professional UUID REFERENCES professional_employees(id);
CREATE TABLE IF NOT EXISTS professional_week_off_versions (
  id BIGSERIAL PRIMARY KEY,
  professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
  week_off_days INTEGER[] NOT NULL,
  old_days INTEGER[] NOT NULL DEFAULT '{}',
  effective_from DATE NOT NULL,
  actor_professional_id UUID REFERENCES professional_employees(id),
  actor_user_id INTEGER REFERENCES users(user_id),
  source TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (week_off_days <@ ARRAY[0,1,2,3,4,5,6])
);
CREATE INDEX IF NOT EXISTS professional_week_off_versions_lookup ON professional_week_off_versions(professional_id, effective_from DESC, id DESC);
-- Preserve legacy schedules for historical reports before the first dated change.
INSERT INTO professional_week_off_versions(professional_id, week_off_days, effective_from, actor_user_id, source)
SELECT p.professional_id, p.week_off_days, '-infinity'::date, p.updated_by, 'legacy'
FROM professional_week_off p WHERE NOT EXISTS (SELECT 1 FROM professional_week_off_versions v WHERE v.professional_id = p.professional_id);

CREATE OR REPLACE FUNCTION capture_professional_week_off() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.week_off_days IS NOT DISTINCT FROM OLD.week_off_days
     AND NEW.effective_from IS NOT DISTINCT FROM OLD.effective_from THEN RETURN NEW; END IF;
  INSERT INTO professional_week_off_versions(professional_id, week_off_days, old_days, effective_from, actor_professional_id, actor_user_id, source)
  VALUES (NEW.professional_id, NEW.week_off_days, professional_week_off_days_at(NEW.professional_id, NEW.effective_from),
    NEW.effective_from, NEW.updated_by_professional, NEW.updated_by,
    CASE WHEN NEW.updated_by_professional IS NULL THEN 'admin' ELSE 'coordinator' END);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS professional_week_off_history ON professional_week_off;
CREATE TRIGGER professional_week_off_history BEFORE INSERT OR UPDATE ON professional_week_off FOR EACH ROW EXECUTE FUNCTION capture_professional_week_off();

CREATE OR REPLACE FUNCTION professional_week_off_days_at(person UUID, on_date DATE) RETURNS INTEGER[] AS $$
  SELECT COALESCE((SELECT week_off_days FROM professional_week_off_versions WHERE professional_id = person AND effective_from <= on_date ORDER BY effective_from DESC, id DESC LIMIT 1), '{}'::int[])
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION professional_is_week_off(person UUID, on_date DATE) RETURNS BOOLEAN AS $$
  SELECT EXTRACT(DOW FROM on_date)::int = ANY(professional_week_off_days_at(person, on_date))
$$ LANGUAGE sql STABLE;

-- One paid calendar day even when attendance, leave, holiday and weekly off overlap.
CREATE OR REPLACE FUNCTION professional_is_paid_day(person UUID, on_date DATE) RETURNS BOOLEAN AS $$
  SELECT professional_is_week_off(person,on_date)
    OR EXISTS (SELECT 1 FROM professional_attendance a WHERE a.professional_id=person AND a.date=on_date AND a.punch_in IS NOT NULL)
    OR EXISTS (SELECT 1 FROM professional_leave_requests l WHERE l.professional_id=person AND l.requested_date=on_date AND l.status='approved')
    OR EXISTS (SELECT 1 FROM professional_holidays h JOIN professional_employees p ON p.id=person
      WHERE h.holiday_date=on_date AND h.city_id=p.city_id AND (h.zone_id IS NULL OR h.zone_id=p.zone_id)
      AND (h.ward_id IS NULL OR h.ward_id=p.ward_id) AND (h.kothi_id IS NULL OR h.kothi_id=p.kothi_id))
$$ LANGUAGE sql STABLE;

INSERT INTO permissions(module, action)
SELECT 'professional-weekly-off', candidate FROM UNNEST(ARRAY['view','write']) candidate
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.module = 'professional-weekly-off' AND p.action = candidate);
