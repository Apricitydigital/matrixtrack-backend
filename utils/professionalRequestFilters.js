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

module.exports = { buildProfessionalRequestFilters, employeeMasterCode };
