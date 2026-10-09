const pool = require('../config/db');
const { encryptAadhar, decryptAadhar } = require('../utils/encryption');
const { getVisibilityCTE, visibilityWhereClause } = require('./supervisorSelfPunchController');
const { getSignedS3Url } = require('../utils/s3SelfPunch');
const { buildProfessionalRequestFilters } = require('../utils/professionalRequestFilters');

const editable = ['full_name', 'mobile', 'email', 'emp_code', 'aadhar_number', 'city_id', 'zone_id', 'ward_id', 'kothi_id'];
const requireListAdmin = async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT email, role FROM users WHERE user_id = $1', [req.supervisorId]);
    if (rows[0]?.email?.trim().toLowerCase() !== 'mtadmin@apricitydigital.in' || rows[0]?.role?.toLowerCase() !== 'admin') {
      return res.status(403).json({ message: 'Only mtadmin@apricitydigital.in can update this list.' });
    }
    next();
  } catch (_) { res.status(500).json({ message: 'Unable to verify administrator.' }); }
};

const getApprovedList = async (req, res) => {
  try {
    const admin = String(req.user.role).toLowerCase() === 'admin';
    const params = admin ? [] : [req.supervisorId];
    const filter = buildProfessionalRequestFilters(req.query, params);
    const { rows } = await pool.query(`${admin ? '' : getVisibilityCTE()}
      SELECT spr.id, spr.full_name, spr.mobile, spr.email, spr.emp_code, spr.aadhar_number,
        spr.city_id, spr.zone_id, spr.ward_id, spr.kothi_id, spr.created_at, spr.updated_at,
        spr.status, c.city_name, z.zone_name,
        COALESCE(s.sector_name, w0.ward_name) AS ward_name, w.ward_name AS kothi_name,
        COALESCE(e.designation_id, (SELECT designation_id FROM designation pd
          JOIN department pdep ON pdep.department_id = pd.department_id
          WHERE pd.designation_name = 'Professional' AND pdep.department_name = 'Professional'
          ORDER BY designation_id LIMIT 1)) AS designation_id,
        'Professional' AS designation_name, 'Professional' AS department_name, e.emp_id AS employee_master_id,
        spr.selfie_url, spr.aadhar_doc_url
      FROM self_punch_requests spr
      LEFT JOIN cities c ON c.city_id = spr.city_id
      LEFT JOIN zones z ON z.zone_id = spr.zone_id
      LEFT JOIN sectors s ON s.sector_id = spr.ward_id
      LEFT JOIN wards w0 ON w0.ward_id = spr.ward_id
      LEFT JOIN wards w ON w.ward_id = spr.kothi_id
      LEFT JOIN employee e ON e.emp_code = COALESCE(NULLIF(spr.emp_code, ''),
        'EMP-' || CASE WHEN NULLIF(spr.mobile, '') IS NOT NULL THEN RIGHT(spr.mobile, 6) ELSE LEFT(spr.id::text, 8) END)
      WHERE spr.status = 'approved' AND ${admin ? 'TRUE' : visibilityWhereClause} ${filter}
      ORDER BY spr.created_at DESC`, params);
    res.set?.('Cache-Control', 'no-store');
    if (req.query.facets === 'true') return res.json({ data: rows.map(row => Object.fromEntries(
      ['city_id', 'city_name', 'zone_id', 'zone_name', 'ward_id', 'ward_name', 'kothi_id', 'kothi_name', 'emp_code'].map(key => [key, row[key]])
    )) });
    for (const row of rows) {
      try { row.aadhar_number = decryptAadhar(row.aadhar_number); }
      catch (_) { row.aadhar_number = ''; }
      row.selfie_url = row.selfie_url ? await getSignedS3Url(row.selfie_url, 900) : '';
      row.aadhar_doc_url = row.aadhar_doc_url ? await getSignedS3Url(row.aadhar_doc_url, 900) : '';
    }
    res.json({ data: rows, editable });
  } catch (err) {
    console.error('Approved list export failed:', err.message);
    res.status(500).json({ message: 'Unable to load employee details.' });
  }
};

const updateApprovedList = async (req, res) => {
  const input = req.body?.rows;
  if (!Array.isArray(input) || input.length === 0 || input.length > 2000) {
    return res.status(400).json({ message: 'Upload between 1 and 2000 employee rows.' });
  }
  let client;
  const preview = req.body.preview !== false;
  try {
    client = await pool.connect();
    await client.query(preview ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    // Serializes list updates, including duplicate identifier validation.
    if (!preview) await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))");
    const seen = new Set();
    const changes = [];
    const errors = [];
    const plans = [];
    let unchanged = 0;
    const validIds = input.map(row => row?.id).filter(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    const existing = validIds.length ? await client.query(`SELECT spr.*, pe.id AS professional_id
      FROM self_punch_requests spr JOIN professional_employees pe ON pe.id = spr.id
      WHERE spr.id = ANY($1::uuid[]) AND spr.status = 'approved'
      ORDER BY spr.id ${preview ? '' : 'FOR UPDATE OF spr, pe'}`, [validIds]) : { rows: [] };
    const employees = new Map(existing.rows.map(row => [String(row.id).toLowerCase(), row]));
    for (let index = 0; index < input.length; index++) {
      const row = input[index];
      const rowNumber = Number.isInteger(row?.row_number) && row.row_number >= 2 ? row.row_number : index + 2;
      const fail = (message) => { const error = new Error(`Row ${index + 2}: ${message}`); error.status = 400; throw error; };
      try {
      if (!row || typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) || seen.has(row.id.toLowerCase())) fail('Invalid or duplicate permanent employee ID.');
      seen.add(row.id.toLowerCase());
      const old = employees.get(row.id.toLowerCase());
      if (!old) fail('Approved employee not found.');
      if (!row.updated_at || new Date(row.updated_at).getTime() !== new Date(old.updated_at).getTime()) fail('Employee changed since download. Download a fresh list.');
      const next = { ...old };
      const changed = {};
      for (const field of editable) {
        // Blank cells preserve current values, so incomplete lists cannot erase profiles.
        if (row[field] === undefined || row[field] === null || String(row[field]).trim() === '') continue;
        let value = String(row[field]).trim();
        if (field === 'email') value = value.toLowerCase();
        let previous = old[field];
        if (field === 'aadhar_number') {
          try { previous = decryptAadhar(previous); } catch (_) { previous = ''; }
        }
        if (field === 'email' && previous) previous = String(previous).trim().toLowerCase();
        // Existing legacy values do not need correction merely to preview a file.
        if (String(previous ?? '') === String(value)) continue;
        if (field.endsWith('_id')) {
          if (!/^\d+$/.test(value) || Number(value) < 1) fail(`${field} must be a positive ID.`);
          value = Number(value);
        }
        if (field === 'mobile' && !/^\d{10,15}$/.test(value)) fail('Mobile must contain 10 to 15 digits.');
        if (field === 'email' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254)) fail('Invalid email.');
        if (field === 'full_name' && value.length > 200) fail('Name is too long.');
        if (field === 'emp_code' && value.length > 50) fail('Employee code is too long.');
        if (field === 'aadhar_number') {
          if (!/^\d{12}$/.test(value)) fail('Aadhaar must contain 12 digits.');
        }
        next[field] = value;
        if (String(previous ?? '') !== String(value)) changed[field] = { before: previous ?? '', after: value };
      }
      if (!Object.keys(changed).length) { unchanged++; continue; }
      const change = { id: row.id, row_number: rowNumber, full_name: next.full_name, emp_code: next.emp_code, fields: changed };
      changes.push(change);
      if (['city_id', 'zone_id', 'ward_id', 'kothi_id'].some(key => changed[key])) {
      const hierarchy = await client.query(`SELECT 1 FROM zones z
        WHERE z.zone_id = $1 AND z.city_id = $2
          AND (EXISTS (SELECT 1 FROM sectors s WHERE s.sector_id = $3 AND s.zone_id = z.zone_id)
            OR EXISTS (SELECT 1 FROM wards w WHERE w.ward_id = $3 AND w.zone_id = z.zone_id))
          AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM wards w WHERE w.ward_id = $4
            AND (w.sector_id = $3 OR w.ward_id = $3) AND COALESCE(w.zone_id,
              (SELECT s.zone_id FROM sectors s WHERE s.sector_id = w.sector_id)) = z.zone_id))`,
      [next.zone_id, next.city_id, next.ward_id, next.kothi_id]);
      if (!hierarchy.rowCount && ['city_id', 'zone_id', 'ward_id', 'kothi_id'].some(key => changed[key])) fail('City, zone, ward and kothi do not belong to the same hierarchy.');
      }
      const identifiers = ['mobile', 'email', 'emp_code'].filter(key => changed[key]);
      if (identifiers.length) {
        const params = [row.id, ...identifiers.map(key => next[key])];
        const condition = identifiers.map((key, index) => key === 'email'
          ? `LOWER(email) = LOWER($${index + 2})` : `${key} = $${index + 2}`).join(' OR ');
        const duplicates = await client.query(`SELECT id FROM professional_employees WHERE id <> $1
          AND (${condition}) LIMIT 1`, params);
        if (duplicates.rowCount) fail('Mobile, email or employee code belongs to another professional.');
      }
      const oldCode = old.emp_code || `EMP-${old.mobile ? old.mobile.slice(-6) : old.id.slice(0, 8)}`;
      const master = await client.query(`SELECT emp_id, designation_id FROM employee WHERE emp_code = $1 ${preview ? '' : 'FOR UPDATE'}`, [oldCode]);
      if (master.rowCount > 1) fail('Employee Master match is ambiguous.');
      if (changed.emp_code) {
        const duplicate = await client.query('SELECT emp_id FROM employee WHERE emp_code = $1 AND emp_id <> $2', [next.emp_code, master.rows[0]?.emp_id || -1]);
        if (duplicate.rowCount) fail('Employee code already exists in Employee Master.');
      }
      plans.push({ row, next, changed, master, rowNumber });
      } catch (error) {
        if (!error.status) throw error;
        errors.push({ row_number: rowNumber, id: row?.id || null, message: error.message.replace(/^Row \d+: /, '') });
      }
    }
    for (const key of ['mobile', 'email', 'emp_code']) {
      const values = new Map();
      for (const plan of plans.filter(plan => plan.changed[key])) {
        const value = String(plan.next[key]);
        values.set(value, [...(values.get(value) || []), plan]);
      }
      for (const group of values.values()) {
        if (group.length < 2) continue;
        for (const plan of group) {
          const message = `${key} is repeated in changed rows of this upload.`;
          const existingError = errors.find(error => error.row_number === plan.rowNumber);
          if (existingError) existingError.message += ` ${message}`;
          else errors.push({ row_number: plan.rowNumber, id: plan.row.id, message });
        }
      }
    }
    const validPlans = plans.filter(plan => !errors.some(error => error.row_number === plan.rowNumber));
    if (!preview && errors.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Row ${errors[0].row_number}: ${errors[0].message} No rows were changed.`, errors });
    }
    // Comparison never writes. Apply revalidates every changed row before writing.
    for (const { row, next, changed, master } of preview ? [] : validPlans) {
      const keys = Object.keys(changed);
      const values = keys.map(key => key === 'aadhar_number' ? encryptAadhar(next[key]) : next[key]);
      if (keys.length) {
        const set = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
        await client.query(`UPDATE self_punch_requests SET ${set}, updated_at = NOW() WHERE id = $${values.length + 1}`, [...values, row.id]);
        await client.query(`UPDATE professional_employees SET ${set} WHERE id = $${values.length + 1}`, [...values, row.id]);
      }
      const masterFields = { full_name: 'name', mobile: 'phone', emp_code: 'emp_code', aadhar_number: 'aadhar_no' };
      const assignments = Object.keys(changed).filter(key => masterFields[key]).map(key => [masterFields[key], next[key]]);
      if (changed.kothi_id || changed.ward_id) assignments.push(['ward_id', next.kothi_id || next.ward_id]);
      if (master.rowCount && assignments.length) {
        await client.query(`UPDATE employee SET ${assignments.map(([key], i) => `${key} = $${i + 1}`).join(', ')} WHERE emp_id = $${assignments.length + 1}`,
          [...assignments.map(([, value]) => value), master.rows[0].emp_id]);
      }
      await client.query(`INSERT INTO self_punch_request_logs
        (request_id, action, performed_by_type, performed_by_id, note)
        VALUES ($1, 'viewed', 'admin', $2, $3)`, [row.id, req.supervisorId, `Bulk details update: ${Object.keys(changed).join(', ')}`]);
    }
    await client.query(preview ? 'ROLLBACK' : 'COMMIT');
    res.json({ success: true, preview, total: input.length, changed: validPlans.length, unchanged,
      invalid: errors.length, errors, changes, can_apply: errors.length === 0 && validPlans.length > 0,
      updated_employees: preview ? [] : validPlans.map(({ row, next }) => ({ id: row.id, full_name: next.full_name, emp_code: next.emp_code })) });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    res.status(error.status || (['23505', '23503', '22001'].includes(error.code) ? 400 : 500)).json({
      message: error.status ? error.message : 'Upload could not be applied. Check duplicate identifiers and field values. No rows were changed.'
    });
  } finally { if (client) client.release(); }
};

module.exports = { getApprovedList, updateApprovedList, requireListAdmin };
