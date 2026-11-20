const { ensureSelfAttendanceDesignation } = require('./selfAttendanceDesignation');
const { decryptAadhar } = require('./encryption');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// Caller owns the transaction. UUID selects the person; legacy shared codes do not.
async function editSelfAttendanceDetails(client, id, body, actorId, cityIds = null) {
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const code = typeof body.emp_code === 'string' ? body.emp_code.trim() : '';
  if (!fullName || fullName.length > 200) fail('Enter a name between 1 and 200 characters.');
  if (!code || code.length > 50) fail('Enter an employee code between 1 and 50 characters.');
  const request = (await client.query('SELECT * FROM self_punch_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!request) fail('Request not found.', 404);
  if (cityIds !== null && !cityIds.includes(Number(request.city_id))) fail('This employee is outside your city access.', 403);
  if (!['pending', 'approved'].includes(request.status)) fail('Only pending or approved requests can be edited.', 409);
  if (!body.updated_at || !Number.isFinite(new Date(body.updated_at).getTime()) ||
      new Date(body.updated_at).getTime() !== new Date(request.updated_at).getTime()) {
    fail('Employee details changed. Refresh the page before editing again.', 409);
  }
  const changes = {};
  if (fullName !== request.full_name) changes.full_name = { before: request.full_name || '', after: fullName };
  if (code !== request.emp_code) changes.emp_code = { before: request.emp_code || '', after: code };
  if (!Object.keys(changes).length) return { changed: false };

  const profile = (await client.query('SELECT * FROM self_attendance_employees WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (request.status === 'approved' && (!profile || !profile.is_active)) fail('The active Self Attendance account is unavailable. Open the current main account.', 409);
  if (request.status === 'pending' && profile) fail('This request already has an account. Refresh and review its status.', 409);
  const oldCode = String(request.emp_code || '').trim() || `EMP-${request.mobile ? request.mobile.slice(-6) : request.id.slice(0, 8)}`;
  const masters = (await client.query('SELECT * FROM employee WHERE emp_code=$1 ORDER BY emp_id FOR UPDATE', [oldCode])).rows;
  if (masters.length > 1) fail('Employee Master mapping is ambiguous.', 409);
  const master = masters[0];
  const belongsToPerson = master && Number(master.ward_id) === Number(request.kothi_id) &&
    (request.mobile ? String(master.phone || '').trim() === String(request.mobile).trim()
      : String(master.name || '').trim() === String(request.full_name || '').trim());
  if (changes.emp_code || (request.status === 'approved' && !belongsToPerson)) {
    const duplicate = (await client.query(`SELECT id FROM self_attendance_employees
      WHERE id<>$1 AND LOWER(TRIM(emp_code))=LOWER($2)
      UNION ALL SELECT id FROM self_punch_requests WHERE id<>$1
      AND status IN ('pending','approved') AND LOWER(TRIM(emp_code))=LOWER($2) LIMIT 1`, [id, code])).rows[0];
    if (duplicate) fail('This employee code belongs to another account or request. Enter a unique employee code.', 409);
  }

  if (request.status === 'approved' && master && !belongsToPerson && !changes.emp_code) {
    fail('This legacy employee code is linked to another person in Employee Master. Enter a new unique employee code to correct this account.', 409);
  }
  // Pending requests never rename an existing Employee Master person.
  const masterId = request.status === 'approved' && belongsToPerson ? master.emp_id : null;
  const codeConflict = (await client.query(`SELECT emp_id FROM employee
    WHERE LOWER(TRIM(emp_code))=LOWER($1) AND ($2::int IS NULL OR emp_id<>$2) LIMIT 1`, [code, masterId])).rows[0];
  if (codeConflict) fail('This employee code already belongs to another Employee Master record.', 409);

  if (request.status === 'approved') {
    if (masterId) {
      await client.query('UPDATE employee SET name=$1,emp_code=$2 WHERE emp_id=$3', [fullName, code, masterId]);
    } else {
      // Repair a missing Master mapping only at the account's verified physical site.
      const site = (await client.query(`SELECT w.ward_id FROM wards w JOIN zones z ON z.zone_id=w.zone_id
        WHERE w.ward_id=$1 AND z.zone_id=$2 AND z.city_id=$3`, [request.kothi_id, request.zone_id, request.city_id])).rows[0];
      if (!site) fail('The employee site mapping needs correction before creating an Employee Master record.', 409);
      const { designationId } = await ensureSelfAttendanceDesignation(client);
      let aadhaar = request.aadhar_number || null;
      if (aadhaar) { try { aadhaar = decryptAadhar(aadhaar); } catch (_) { fail('The Aadhaar document details need correction before creating an Employee Master record.', 409); } }
      await client.query(`INSERT INTO employee (name,emp_code,phone,ward_id,designation_id,
        aadhar_no,aadhar_url,face_embedding,self_attendance_enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)`, [fullName, code, request.mobile || null,
        site.ward_id, designationId, aadhaar, request.aadhar_doc_url || null, request.selfie_url || null]);
    }
    await client.query('UPDATE self_attendance_employees SET full_name=$1,emp_code=$2 WHERE id=$3', [fullName, code, id]);
  }
  await client.query('UPDATE self_punch_requests SET full_name=$1,emp_code=$2,updated_at=clock_timestamp() WHERE id=$3', [fullName, code, id]);
  await client.query(`INSERT INTO self_punch_request_logs(request_id,action,performed_by_type,performed_by_id,note)
    VALUES($1,'viewed','admin',$2,$3)`, [id, actorId, `Employee details updated: ${JSON.stringify(changes)}`]);
  return { changed: true, full_name: fullName, emp_code: code };
}

module.exports = { editSelfAttendanceDetails };
