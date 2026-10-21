const { decryptAadhar } = require('./encryption');

function normalizeProfessionalIdentifier(field, value) {
  const text = String(value || '').trim();
  if (field === 'email') return text.toLowerCase();
  if (field === 'emp_code') return text.replace(/\s+/g, '').toLowerCase();
  if (field === 'mobile') {
    const digits = text.replace(/[^0-9]/g, '');
    return /^(?:0091|91)\d{10}$/.test(digits) ? digits.slice(-10) : digits;
  }
  throw new Error('Unsupported professional identifier');
}

function professionalIdentifierSql(field, alias = '') {
  if (!['mobile','email','emp_code'].includes(field) || (alias && !/^[a-z_][a-z_0-9]*$/i.test(alias))) throw new Error('Unsupported professional identifier');
  const column = alias ? `${alias}.${field}` : field;
  if (field === 'email') return `LOWER(TRIM(${column}))`;
  if (field === 'emp_code') return `LOWER(REGEXP_REPLACE(TRIM(${column}),'[[:space:]]+','','g'))`;
  const digits = `REGEXP_REPLACE(TRIM(${column}),'[^0-9]','','g')`;
  return `(CASE WHEN ${digits} ~ '^(0091|91)[0-9]{10}$' THEN RIGHT(${digits},10) ELSE ${digits} END)`;
}

const identityVerificationError = () => Object.assign(new Error('Identity details could not be verified. Ask an administrator to review the existing records.'), {
  status:409, code:'PROFESSIONAL_IDENTITY_UNVERIFIED',
});

function readProfessionalAadhaar(value) {
  if (!value) throw identityVerificationError();
  let plain;
  try { plain = /^\d{12}$/.test(String(value).trim()) ? String(value).trim() : decryptAadhar(value); }
  catch (_) { throw identityVerificationError(); }
  if (!/^\d{12}$/.test(plain || '')) throw identityVerificationError();
  return plain;
}

async function findProfessionalAadhaarConflict(client, value, {excludeRequestId=null, cache={}} = {}) {
  const plain = readProfessionalAadhaar(value);
  // Kept only for this request/transaction. Never store or log the plaintext
  // index; randomized encryption means ciphertext equality is insufficient.
  if (!cache.aadhaarOwners) {
    const {rows} = await client.query(`SELECT id,full_name,emp_code,aadhar_number,'account' AS source
      FROM professional_employees
      UNION ALL
      SELECT id,full_name,emp_code,aadhar_number,'request' AS source FROM self_punch_requests
      WHERE status IN ('pending','approved')`);
    const index = new Map();
    for (const row of rows) {
      const key = readProfessionalAadhaar(row.aadhar_number);
      const {aadhar_number, ...owner} = row;
      const owners = index.get(key) || [];
      owners.push(owner); index.set(key, owners);
    }
    cache.aadhaarOwners = index;
  }
  return (cache.aadhaarOwners.get(plain) || []).find(owner => String(owner.id).toLowerCase() !== String(excludeRequestId || '').toLowerCase()) || null;
}

async function findProfessionalIdentityConflict(client, { mobile, email, empCode, aadharNumber, requireAadhaar=false, excludeRequestId = null }) {
  const params = [normalizeProfessionalIdentifier('mobile',mobile), normalizeProfessionalIdentifier('email',email), normalizeProfessionalIdentifier('emp_code',empCode), excludeRequestId];
  const { rows } = await client.query(`SELECT id, source FROM (
    SELECT pe.id, 'account' AS source FROM professional_employees pe
    WHERE ($4::uuid IS NULL OR pe.id <> $4)
      AND ((NULLIF($1, '') IS NOT NULL AND ${professionalIdentifierSql('mobile','pe')} = $1)
        OR (NULLIF($2, '') IS NOT NULL AND ${professionalIdentifierSql('email','pe')} = $2)
        OR (NULLIF($3, '') IS NOT NULL AND ${professionalIdentifierSql('emp_code','pe')} = $3))
    UNION ALL
    SELECT spr.id, 'request' AS source FROM self_punch_requests spr
    WHERE spr.status IN ('pending', 'approved') AND ($4::uuid IS NULL OR spr.id <> $4)
      AND ((NULLIF($1, '') IS NOT NULL AND ${professionalIdentifierSql('mobile','spr')} = $1)
        OR (NULLIF($2, '') IS NOT NULL AND ${professionalIdentifierSql('email','spr')} = $2)
        OR (NULLIF($3, '') IS NOT NULL AND ${professionalIdentifierSql('emp_code','spr')} = $3))
  ) conflicts LIMIT 1`, params);
  if (rows[0]) return rows[0];
  if (aadharNumber || requireAadhaar) return findProfessionalAadhaarConflict(client, aadharNumber, {excludeRequestId});
  return null;
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

module.exports = { findProfessionalIdentityConflict, findProfessionalAadhaarConflict, readProfessionalAadhaar,
  normalizeProfessionalIdentifier, professionalIdentifierSql, hasAadhaarRequestAtWard };
