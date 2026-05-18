# Safe Structure Migration (No Data Delete)

This flow applies **schema/structure only** on target DB and avoids data-delete statements.

## What it does

- Runs SQL files from `db/migrations` in sorted order.
- Skips any migration file with `_down` in filename.
- Blocks these SQL statements:
  - `DELETE`
  - `TRUNCATE`
  - `DROP TABLE`
  - `DROP SCHEMA`
  - `DROP DATABASE`
- Tracks applied files in `schema_migrations_safe`.
- Runs runtime schema initializers:
  - RBAC schema ensure (`ensureRbacSchema`)
  - Professional leave schema ensure (`ensureProfessionalLeaveSchema`)

## Commands

```bash
npm run migrate:structure:safe:dry
npm run migrate:structure:safe
npm run migrate:structure:safe:force
npm run migrate:structure:safe:force:autopunch
```

`migrate:structure:safe:force` ignores migration-log skip and re-attempts idempotent structure apply.
`migrate:structure:safe:force:autopunch` skips `20260311_expand_leave_types.sql` (useful when only auto-punch/self-punch rollout is needed).

## Before running on production

1. Set production DB env in `.env`:
   - `DB_HOST`
   - `DB_PORT`
   - `DB_NAME`
   - `DB_USER`
   - `DB_PASSWORD`
2. Take a backup (recommended).
3. Run dry-run first.
4. Run actual safe migration.

## Notes

- Script is **non-destructive for rows** (no delete/truncate).
- Some migrations may still contain `DROP CONSTRAINT` or `DROP TRIGGER`; these are object-level operations, not row deletion.
- Re-run is safe due to idempotent SQL and migration tracking.
