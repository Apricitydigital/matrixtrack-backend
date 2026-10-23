-- Preserve full professional UUIDs as well as legacy numeric account IDs.
ALTER TABLE user_consent_logs ALTER COLUMN user_id TYPE TEXT USING user_id::text;
