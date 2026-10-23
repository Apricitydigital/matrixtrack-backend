-- Old audits have no complete change journal and are deliberately not labelled
-- recoverable. The 48-hour window starts only on a newly journaled merge.
ALTER TABLE workforce_merge_audit ADD COLUMN IF NOT EXISTS restore_until TIMESTAMPTZ;
ALTER TABLE workforce_merge_audit ADD COLUMN IF NOT EXISTS recovery_version INTEGER;
ALTER TABLE workforce_merge_audit ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;
ALTER TABLE workforce_merge_audit ADD COLUMN IF NOT EXISTS reverted_by INTEGER;
ALTER TABLE workforce_merge_audit ADD COLUMN IF NOT EXISTS revert_reason TEXT;
CREATE TABLE IF NOT EXISTS workforce_merge_changes (
 id BIGSERIAL PRIMARY KEY,
 merge_id BIGINT NOT NULL REFERENCES workforce_merge_audit(id) ON DELETE RESTRICT,
 table_schema TEXT NOT NULL, table_name TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
 key_columns TEXT[] NOT NULL,
 before_row JSONB, after_row JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS workforce_merge_changes_audit ON workforce_merge_changes(merge_id,id);

CREATE OR REPLACE FUNCTION workforce_capture_merge_change() RETURNS TRIGGER AS $$
DECLARE merge_key TEXT; previous_row JSONB; next_row JSONB; keys TEXT[];
BEGIN
 merge_key:=current_setting('matrixtrack.merge_id',true);
 IF merge_key IS NULL OR merge_key='' THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN previous_row:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN next_row:=to_jsonb(NEW); END IF;
 IF previous_row IS NOT DISTINCT FROM next_row THEN RETURN NULL; END IF;
 SELECT COALESCE(array_agg(a.attname ORDER BY k.ordinality),'{}'::text[]) INTO keys
 FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
 WHERE i.indrelid=TG_RELID AND i.indisprimary;
 INSERT INTO workforce_merge_changes(merge_id,table_schema,table_name,operation,key_columns,before_row,after_row)
 VALUES(merge_key::bigint,TG_TABLE_SCHEMA,TG_TABLE_NAME,TG_OP,keys,previous_row,next_row);
 RETURN NULL;
END;
$$ LANGUAGE plpgsql;
