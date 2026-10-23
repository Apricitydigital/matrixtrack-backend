const employeeMasterCode = `COALESCE(NULLIF(spr.emp_code, ''),
  'EMP-' || CASE WHEN NULLIF(spr.mobile, '') IS NOT NULL THEN RIGHT(spr.mobile, 6) ELSE LEFT(spr.id::text, 8) END)`;
const contains = value => `%${String(value).trim().replace(/[\\%_]/g, '\\$&')}%`;

// Shared by paginated results, counts and Excel download so they always match.
function buildProfessionalRequestFilters(query, params) {
  let sql = '';
  for (const field of ['city_id', 'zone_id', 'ward_id', 'kothi_id', 'emp_code']) {
    if (!query[field]) continue;
    params.push(String(query[field]).trim());
    sql += ` AND spr.${field}::text = $${params.length}`;
  }
  if (String(query.employee_name || '').trim()) {
    params.push(contains(query.employee_name));
    sql += ` AND spr.full_name ILIKE $${params.length}`;
  }
  if (String(query.mobile || '').trim()) {
    const { normalizeProfessionalIdentifier, professionalIdentifierSql } = require('./professionalIdentity');
    const mobile = normalizeProfessionalIdentifier('mobile', query.mobile);
    if (!/^\d{1,10}$/.test(mobile)) sql += ' AND FALSE';
    else {
      params.push(`%${mobile}%`);
      sql += ` AND ${professionalIdentifierSql('mobile', 'spr')} LIKE $${params.length}`;
    }
  }
  const id = String(query.employee_id || '').trim();
  if (id) {
    if (/^\d+$/.test(id)) {
      params.push(id);
      sql += ` AND EXISTS (SELECT 1 FROM employee em WHERE em.emp_id::text = $${params.length} AND em.emp_code = ${employeeMasterCode})`;
    } else {
      params.push(contains(id));
      sql += ` AND spr.id::text ILIKE $${params.length}`;
    }
  }
  return sql;
}

// Aadhaar uses randomized encryption, so compare decrypted values only within
// the reviewer's visible, filtered scope, before pagination and counting.
async function buildScopedProfessionalRequestFilters(query, params, { client, visibilitySql = '', where = 'TRUE' }) {
  let sql = buildProfessionalRequestFilters(query, params);
  if (String(query.aadhar_number || '').trim() && !/^\d{12}$/.test(String(query.aadhar_number).replace(/[\s-]/g, ''))) return sql + ' AND FALSE';
  // Registration requests remain for audit/recovery, but merged source IDs
  // must not appear as separate employees in lists, counts or exports.
  const aliases = await client.query("SELECT to_regclass('workforce_employee_aliases') IS NOT NULL AS available");
  if (aliases.rows[0]?.available) {
    sql += " AND NOT EXISTS (SELECT 1 FROM workforce_employee_aliases merged WHERE merged.employee_kind = 'professional' AND merged.source_id = spr.id::text)";
  }
  if (!String(query.aadhar_number || '').trim()) return sql;
  const aadhaar = String(query.aadhar_number).replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(aadhaar)) return sql + ' AND FALSE';
  const { readProfessionalAadhaar } = require('./professionalIdentity');
  const { rows } = await client.query(`${visibilitySql}
    SELECT spr.id, spr.aadhar_number FROM self_punch_requests spr
    WHERE ${where} ${sql}`, params);
  const ids = rows.filter(row => {
    try { return readProfessionalAadhaar(row.aadhar_number) === aadhaar; }
    catch (_) { return false; }
  }).map(row => row.id);
  params.push(ids);
  return sql + ` AND spr.id = ANY($${params.length}::uuid[])`;
}

module.exports = { buildProfessionalRequestFilters, buildScopedProfessionalRequestFilters, employeeMasterCode };
