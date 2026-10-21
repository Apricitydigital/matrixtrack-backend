-- New punches record the actual site independently of later profile transfers.
-- Existing rows remain NULL: their historical site cannot be safely inferred.
ALTER TABLE professional_attendance ADD COLUMN IF NOT EXISTS kothi_id INTEGER;
CREATE INDEX IF NOT EXISTS professional_attendance_site_date ON professional_attendance(kothi_id,date);
ALTER TABLE employee ADD COLUMN IF NOT EXISTS self_attendance_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE professional_attendance
 ADD COLUMN IF NOT EXISTS punch_in_latitude DOUBLE PRECISION,
 ADD COLUMN IF NOT EXISTS punch_in_longitude DOUBLE PRECISION,
 ADD COLUMN IF NOT EXISTS punch_out_latitude DOUBLE PRECISION,
 ADD COLUMN IF NOT EXISTS punch_out_longitude DOUBLE PRECISION,
 ADD COLUMN IF NOT EXISTS punch_in_photo_url VARCHAR(1024),
 ADD COLUMN IF NOT EXISTS punch_out_photo_url VARCHAR(1024),
 ADD COLUMN IF NOT EXISTS auto_punched_out BOOLEAN DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS out_address TEXT;
