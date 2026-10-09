const { decryptAadhar } = require('./encryption');

async function findProfessionalIdentityConflict(client, { mobile, email, empCode, excludeRequestId = null }) {
  const params = [String(mobile || '').trim(), String(email || '').trim().toLowerCase(), String(empCode || '').trim(), excludeRequestId];
  const { rows } = await client.query(`SELECT id, source FROM (
    SELECT pe.id, 'account' AS source FROM professional_employees pe
    WHERE ($4::uuid IS NULL OR pe.id <> $4)
      AND ((NULLIF($1, '') IS NOT NULL AND pe.mobile = $1)
        OR (NULLIF($2, '') IS NOT NULL AND LOWER(TRIM(pe.email)) = $2)
        OR (NULLIF($3, '') IS NOT NULL AND LOWER(TRIM(pe.emp_code)) = LOWER($3)))
    UNION ALL
    SELECT spr.id, 'request' AS source FROM self_punch_requests spr
    WHERE spr.status IN ('pending', 'approved') AND ($4::uuid IS NULL OR spr.id <> $4)
      AND ((NULLIF($1, '') IS NOT NULL AND spr.mobile = $1)
        OR (NULLIF($2, '') IS NOT NULL AND LOWER(TRIM(spr.email)) = $2)
        OR (NULLIF($3, '') IS NOT NULL AND LOWER(TRIM(spr.emp_code)) = LOWER($3)))
  ) conflicts LIMIT 1`, params);
  return rows[0] || null;
}

async function hasAadhaarRequestAtWard(client, aadhaar, wardId) {
  // Encryption uses a random IV: ciphertext equality cannot detect duplicates.
  const { rows } = await client.query(`SELECT aadhar_number FROM self_punch_requests
    WHERE ward_id = $1 AND status IN ('pending', 'approved')`, [wardId]);
  return rows.some(row => {
    try { return decryptAadhar(row.aadhar_number) === aadhaar; }
    catch (_) { return false; }
  });
}

module.exports = { findProfessionalIdentityConflict, hasAadhaarRequestAtWard };
