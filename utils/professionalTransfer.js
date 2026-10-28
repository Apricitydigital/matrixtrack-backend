const fields = ['city_id', 'zone_id', 'ward_id', 'kothi_id'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// The caller owns the transaction. Only current assignment columns are written;
// attendance, credentials, documents, leave and face records are never rewritten.
// Employee reports use this current assignment for the complete attendance
// history, so past and future transfers carry history without a data backfill.
async function transferProfessional(client, id, body, actorId, cityIds = null) {
  const next = {};
  for (const field of fields) {
    const value = String(body[field] ?? '');
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) fail('Select a valid city, zone, ward and kothi.');
    next[field] = Number(value);
  }
  const reason = String(body.reason || '').trim();
  if (reason.length < 3 || reason.length > 1000) fail('Enter a transfer reason between 3 and 1000 characters.');
  const request = (await client.query(`SELECT spr.*,c.city_name,z.zone_name,s.sector_name AS ward_name,w.ward_name AS kothi_name
    FROM self_punch_requests spr LEFT JOIN cities c ON c.city_id=spr.city_id
    LEFT JOIN zones z ON z.zone_id=spr.zone_id LEFT JOIN sectors s ON s.sector_id=spr.ward_id
    LEFT JOIN wards w ON w.ward_id=spr.kothi_id WHERE spr.id=$1 FOR UPDATE OF spr`, [id])).rows[0];
  if (!request) fail('Request not found.', 404);
  if (cityIds !== null && (!cityIds.includes(Number(request.city_id)) || !cityIds.includes(next.city_id))) fail('Both current and destination cities must be within your access.', 403);
  if (request.status !== 'approved') fail('Only approved professionals can be transferred.', 409);
  if (!body.updated_at || !Number.isFinite(new Date(body.updated_at).getTime()) || new Date(body.updated_at).getTime() !== new Date(request.updated_at).getTime()) fail('Employee details changed. Refresh and review the transfer again.', 409);
  const profile = (await client.query('SELECT * FROM professional_employees WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!profile) fail('The original professional account is unavailable or was merged. Open the current main account.', 409);
  if (fields.every(field => Number(request[field]) === next[field] && Number(profile[field]) === next[field])) fail('Choose a different assignment.');
  const destination = (await client.query(`SELECT c.city_name,z.zone_name,s.sector_name AS ward_name,w.ward_name AS kothi_name
    FROM cities c JOIN zones z ON z.city_id=c.city_id JOIN sectors s ON s.zone_id=z.zone_id
    JOIN wards w ON w.sector_id=s.sector_id
    WHERE c.city_id=$1 AND z.zone_id=$2 AND s.sector_id=$3 AND w.ward_id=$4
    AND (w.zone_id IS NULL OR w.zone_id=z.zone_id)
    FOR SHARE OF c,z,s,w`, fields.map(field => next[field]))).rows[0];
  if (!destination) fail('City, zone, ward and kothi must belong to the same hierarchy.');
  const code = request.emp_code || `EMP-${request.mobile ? request.mobile.slice(-6) : request.id.slice(0, 8)}`;
  const masters = (await client.query('SELECT emp_id FROM employee WHERE emp_code=$1 ORDER BY emp_id FOR UPDATE', [code])).rows;
  if (masters.length > 1) fail('Multiple Employee Master records use this code. Resolve that mapping before transferring.', 409);
  const values = [...fields.map(field => next[field]), id];
  await client.query('UPDATE self_punch_requests SET city_id=$1,zone_id=$2,ward_id=$3,kothi_id=$4,updated_at=clock_timestamp() WHERE id=$5', values);
  await client.query('UPDATE professional_employees SET city_id=$1,zone_id=$2,ward_id=$3,kothi_id=$4 WHERE id=$5', values);
  if (masters.length) await client.query('UPDATE employee SET ward_id=$1 WHERE emp_id=$2', [next.kothi_id, masters[0].emp_id]);
  // Reuse the existing enum-compatible audit event; the note identifies transfer.
  await client.query(`INSERT INTO self_punch_request_logs(request_id,action,performed_by_type,performed_by_id,note)
    VALUES($1,'viewed','admin',$2,$3)`, [id, actorId, `Professional transfer: ${[request.city_name,request.zone_name,request.ward_name,request.kothi_name].map(value=>value || 'Unassigned').join(' / ')} (${fields.map(field=>request[field] ?? '-').join('/')}) → ${Object.values(destination).join(' / ')} (${fields.map(field=>next[field]).join('/')}). Reason: ${reason}`]);
  return { ...next, ...destination };
}
module.exports = { transferProfessional };
