-- Align attendance time columns with current application expectations.
-- This migration is idempotent and safe to run in production.
--
-- Expected shape used by current backend code:
--   - punch_in_time: timestamp without time zone (stored as IST wall-clock time)
--   - punch_out_time: timestamp without time zone (stored as IST wall-clock time)
--   - mid_shift_punch_in_time: timestamp with time zone
--
-- If punch_in_time / punch_out_time are timestamptz in any environment,
-- convert them to IST wall-clock timestamp (without tz) to preserve display behavior.

DO $$
DECLARE
  punch_in_type text;
  punch_out_type text;
  mid_shift_type text;
BEGIN
  SELECT data_type
    INTO punch_in_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'attendance'
    AND column_name = 'punch_in_time';

  SELECT data_type
    INTO punch_out_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'attendance'
    AND column_name = 'punch_out_time';

  SELECT data_type
    INTO mid_shift_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'attendance'
    AND column_name = 'mid_shift_punch_in_time';

  IF punch_in_type = 'timestamp with time zone' THEN
    EXECUTE $sql$
      ALTER TABLE public.attendance
      ALTER COLUMN punch_in_time TYPE timestamp without time zone
      USING (punch_in_time AT TIME ZONE 'Asia/Kolkata')
    $sql$;
  END IF;

  IF punch_out_type = 'timestamp with time zone' THEN
    EXECUTE $sql$
      ALTER TABLE public.attendance
      ALTER COLUMN punch_out_time TYPE timestamp without time zone
      USING (punch_out_time AT TIME ZONE 'Asia/Kolkata')
    $sql$;
  END IF;

  IF mid_shift_type = 'timestamp without time zone' THEN
    EXECUTE $sql$
      ALTER TABLE public.attendance
      ALTER COLUMN mid_shift_punch_in_time TYPE timestamp with time zone
      USING (mid_shift_punch_in_time AT TIME ZONE 'Asia/Kolkata')
    $sql$;
  END IF;
END $$;

