-- Soft Delete Support for Admin Accounts
-- Run once on DB:
-- psql -h <host> -U <user> -d <db> -f 20260623_soft_delete_admins.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Ensure existing rows are marked as not deleted
UPDATE users SET is_deleted = FALSE WHERE is_deleted IS NULL;
