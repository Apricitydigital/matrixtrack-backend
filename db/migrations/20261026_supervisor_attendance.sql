CREATE TABLE IF NOT EXISTS supervisor_attendance_faces (
 emp_id INTEGER PRIMARY KEY REFERENCES employee(emp_id), site_id INTEGER NOT NULL REFERENCES wards(ward_id),
 collection_id TEXT NOT NULL, face_id TEXT NOT NULL, photo_key TEXT NOT NULL, source_ref TEXT NOT NULL,
 version UUID NOT NULL DEFAULT gen_random_uuid(), enrolled_by UUID NOT NULL REFERENCES professional_employees(id),
 enrolled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), consent_recorded BOOLEAN NOT NULL,
 UNIQUE(collection_id,face_id)
);
CREATE TABLE IF NOT EXISTS supervisor_attendance_captures (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID NOT NULL REFERENCES professional_employees(id),
 site_id INTEGER NOT NULL REFERENCES wards(ward_id), request_key TEXT NOT NULL, image_digest TEXT NOT NULL,
 punch_type TEXT NOT NULL CHECK(punch_type IN ('in','out')), group_capture BOOLEAN NOT NULL,
 image_key TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,request_key)
);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS supervisor_in_by UUID REFERENCES professional_employees(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS supervisor_out_by UUID REFERENCES professional_employees(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS supervisor_in_name TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS supervisor_out_name TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS supervisor_in_capture UUID REFERENCES supervisor_attendance_captures(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS supervisor_out_capture UUID REFERENCES supervisor_attendance_captures(id);
CREATE INDEX IF NOT EXISTS supervisor_faces_site ON supervisor_attendance_faces(site_id,emp_id);

CREATE TABLE IF NOT EXISTS supervisor_attendance_face_checks (
 emp_id INTEGER NOT NULL REFERENCES employee(emp_id),site_id INTEGER NOT NULL REFERENCES wards(ward_id),
 source_ref TEXT NOT NULL,recapture_required BOOLEAN NOT NULL DEFAULT TRUE,reason TEXT,
 checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(emp_id,site_id)
);

-- Keep new group evidence private. Its original object reference stays in captures;
-- the legacy public image reader must never receive a copy of that reference.
UPDATE attendance a SET punch_in_image=NULL FROM supervisor_attendance_captures c
 WHERE a.supervisor_in_capture=c.id AND c.image_key<>'' AND a.punch_in_image IS NOT NULL;
UPDATE attendance a SET punch_out_image=NULL FROM supervisor_attendance_captures c
 WHERE a.supervisor_out_capture=c.id AND c.image_key<>'' AND a.punch_out_image IS NOT NULL;
