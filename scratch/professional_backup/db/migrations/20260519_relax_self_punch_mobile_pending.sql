-- Allow multiple pending self-punch requests for the same mobile number.
-- Keep app-level caps:
--   - 40 requests/hour per IP+mobile (rate limiter)
--   - 10 requests/day per mobile (controller check)

DROP INDEX IF EXISTS uidx_spr_mobile_pending;
