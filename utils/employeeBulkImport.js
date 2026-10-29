const MAX_ROWS = 500;
const text = value => value == null ? '' : String(value).trim();
const key = value => text(value).toLowerCase();
const allowed = (ids, id) => ids === null || ids.includes(Number(id));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

async function importOptions(client, cityIds = [], kothiIds = []) {
  const locations = (await client.query(`SELECT c.city_id,c.city_name AS city,z.zone_id,z.zone_name AS zone,
    s.sector_id AS ward_id,s.sector_name AS ward,w.ward_id AS kothi_id,w.ward_name AS kothi
    FROM wards w JOIN sectors s ON s.sector_id=w.sector_id
    JOIN zones z ON z.zone_id=s.zone_id JOIN cities c ON c.city_id=z.city_id
    WHERE (w.zone_id IS NULL OR w.zone_id=z.zone_id)
    AND ($1::int[] IS NULL OR c.city_id=ANY($1))
    AND ($2::int[] IS NULL OR w.ward_id=ANY($2))
    ORDER BY c.city_name,z.zone_name,s.sector_name,w.ward_name,w.ward_id`, [cityIds, kothiIds])).rows;
  const designations = (await client.query(`SELECT d.department_id,d.department_name AS department,
    ds.designation_id,ds.designation_name AS designation FROM designation ds
    JOIN department d ON d.department_id=ds.department_id
    ORDER BY d.department_name,ds.designation_name,ds.designation_id`)).rows;
  return { locations, designations, max_rows: MAX_ROWS };
}

// Accept exact names (case-insensitive) or the IDs from the reference sheets.
const matches = (value, row, field, idField) => key(value) === key(row[field]) || text(value) === String(row[idField]);

async function validateImport(client, input, options, cityIds = [], kothiIds = []) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_ROWS) fail(`Upload between 1 and ${MAX_ROWS} employee rows.`);
  const errors = [], rows = [], rowNumbers = new Set();
  const addError = (row, message) => errors.push({ row_number: row.row_number, emp_code: row.emp_code, message });
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const row = { row_number: Number.isSafeInteger(raw?.row_number) && raw.row_number >= 2 ? raw.row_number : i + 2 };
    if (row.row_number > MAX_ROWS + 1 || rowNumbers.has(row.row_number)) fail('Spreadsheet row numbers must be unique and between 2 and 501.');
    rowNumbers.add(row.row_number);
    rows.push(row);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { addError(row, 'Invalid employee row.'); continue; }
    for (const field of ['name','emp_code','aadhar_no','phone','no_personal_phone','city','zone','ward','kothi','department','designation']) {
      if (raw[field] != null && !['string','number','boolean'].includes(typeof raw[field])) addError(row, `${field}: use a plain value.`);
      row[field] = text(raw[field]);
    }
    if (!row.name || row.name.length > 100) addError(row, 'Name is required and must be at most 100 characters.');
    if (!row.emp_code || row.emp_code.length > 50) addError(row, 'Employee code is required and must be at most 50 characters.');
    if (row.aadhar_no && !/^\d{12}$/.test(row.aadhar_no)) addError(row, 'Aadhaar must contain exactly 12 digits, or be blank.');
    const flag = key(row.no_personal_phone);
    if (!['','yes','no','true','false','1','0'].includes(flag)) addError(row, 'No Personal Phone must be Yes or No.');
    row.no_personal_phone = ['yes','true','1'].includes(flag);
    row.phone = row.phone.replace(/[\s()+-]/g, '');
    if (/^91\d{10}$/.test(row.phone)) row.phone = row.phone.slice(2);
    if (row.no_personal_phone && row.phone) addError(row, 'Leave Phone blank when No Personal Phone is Yes.');
    if (!row.no_personal_phone && !/^\d{10}$/.test(row.phone)) addError(row, 'Enter a 10-digit phone number, or set No Personal Phone to Yes.');
    if (row.no_personal_phone) row.phone = null;
    const locations = options.locations.filter(location =>
      [['city','city_id'],['zone','zone_id'],['ward','ward_id'],['kothi','kothi_id']].every(([field,idField]) => row[field] && matches(row[field],location,field,idField)));
    if (locations.length !== 1) addError(row, 'City / Zone / Ward / Kothi must match one location in the Locations sheet. Use IDs if names are ambiguous.');
    else {
      Object.assign(row, locations[0]);
      if (!allowed(cityIds,row.city_id) || !allowed(kothiIds,row.kothi_id)) addError(row, 'This location is outside your access.');
    }
    const designations = options.designations.filter(designation => row.department && row.designation &&
      matches(row.department,designation,'department','department_id') && matches(row.designation,designation,'designation','designation_id'));
    if (designations.length !== 1) addError(row, 'Department / Designation must match one entry in the Designations sheet. Use IDs if names are ambiguous.');
    else Object.assign(row,designations[0]);
  }
  for (const field of ['emp_code','phone','aadhar_no']) {
    const seen = new Map();
    for (const row of rows) {
      const value = key(row[field]);
      if (!value) continue;
      if (seen.has(value)) {
        addError(row, `Duplicate ${field} in this upload (also row ${seen.get(value).row_number}).`);
        if (!seen.get(value).duplicate?.has(field)) {
          addError(seen.get(value), `Duplicate ${field} in this upload (also row ${row.row_number}).`);
          (seen.get(value).duplicate ||= new Set()).add(field);
        }
      } else seen.set(value,row);
    }
  }
  const codes = rows.map(row => key(row.emp_code)).filter(Boolean);
  const phones = rows.map(row => row.phone).filter(Boolean);
  const aadhaars = rows.map(row => row.aadhar_no).filter(Boolean);
  const conflicts = (await client.query(`SELECT lower(trim(emp_code)) AS code,
    right(regexp_replace(phone,'[^0-9]','','g'),10) AS phone,trim(aadhar_no) AS aadhaar FROM employee
    WHERE lower(trim(emp_code))=ANY($1::text[]) OR right(regexp_replace(phone,'[^0-9]','','g'),10)=ANY($2::text[]) OR trim(aadhar_no)=ANY($3::text[])
    UNION ALL SELECT lower(trim(emp_code)),right(regexp_replace(mobile,'[^0-9]','','g'),10),NULL FROM professional_employees
    WHERE lower(trim(emp_code))=ANY($1::text[]) OR right(regexp_replace(mobile,'[^0-9]','','g'),10)=ANY($2::text[])
    UNION ALL SELECT lower(trim(emp_code)),right(regexp_replace(mobile,'[^0-9]','','g'),10),NULL FROM self_punch_requests
    WHERE status IN ('pending','approved') AND (lower(trim(emp_code))=ANY($1::text[]) OR right(regexp_replace(mobile,'[^0-9]','','g'),10)=ANY($2::text[]))`, [codes,phones,aadhaars])).rows;
  const existing = {
    emp_code: new Set(conflicts.map(row => row.code).filter(Boolean)),
    phone: new Set(conflicts.map(row => row.phone).filter(Boolean)),
    aadhar_no: new Set(conflicts.map(row => row.aadhaar).filter(Boolean)),
  };
  for (const row of rows) {
    delete row.duplicate;
    for (const field of Object.keys(existing)) if (row[field] && existing[field].has(field === 'emp_code' ? key(row[field]) : row[field])) addError(row, `${field} is already registered. Existing employees cannot be overwritten by import.`);
  }
  const invalid = new Set(errors.map(error => error.row_number));
  return { total: rows.length, valid: rows.filter(row => !invalid.has(row.row_number)).length, invalid: invalid.size, errors, rows, can_import: errors.length === 0 };
}

// The caller owns the transaction, and must revalidate on apply.
async function insertImport(client, rows) {
  const values = rows.map(row => ({emp_code:row.emp_code,name:row.name,phone:row.phone,ward_id:row.kothi_id,
    designation_id:row.designation_id,aadhar_no:row.aadhar_no || null,no_personal_phone:row.no_personal_phone}));
  const inserted = await client.query(`INSERT INTO employee(emp_code,name,phone,ward_id,designation_id,aadhar_no,no_personal_phone)
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(emp_code text,name text,phone text,ward_id int,designation_id int,aadhar_no text,no_personal_phone boolean)
    RETURNING emp_id,emp_code,name`, [JSON.stringify(values)]);
  return inserted.rows;
}

module.exports = { MAX_ROWS, importOptions, validateImport, insertImport };
