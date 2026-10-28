const pool = require('../config/db');
const { getSignedS3Url } = require('../utils/s3SelfPunch');
const { issueImageAccess } = require('../utils/attendanceImageAccess');
const { signSupervisorAttendancePhotos } = require('../utils/supervisorAttendancePhotos');
const { modeJoin, modeFields } = require('../utils/employeeAttendanceMode');

const fail = (code, message, status = 400) => { throw Object.assign(Error(message), { code, status }); };
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647;
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const meta = () => ({ api_version: 'v1', timezone: 'Asia/Kolkata', image_url_expires_in_seconds: 900, timestamp: new Date().toISOString() });
function dates(query, daily = false) {
  const from = daily || query.date ? query.date : query.from;
  const to = daily || query.date ? query.date : query.to;
  if (!isoDate(from) || !isoDate(to)) fail('INVALID_DATE', 'Provide date or from and to in YYYY-MM-DD format.');
  if (from > to) fail('INVALID_RANGE', "'from' must be <= 'to'.");
  if ((Date.parse(to) - Date.parse(from)) / 86400000 >= 31) fail('RANGE_TOO_LARGE', 'Max date range is 31 inclusive days.');
  return { from, to };
}
function pagination(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!positive(page) || !positive(limit) || limit > 200 || !Number.isSafeInteger((page - 1) * limit)) fail('INVALID_PAGINATION', 'Use a positive page and limit between 1 and 200.');
  return { page, limit, offset: (page - 1) * limit };
}
// Key restrictions and request filters intersect; request parameters never replace key scope.
function scope(req, params, columns) {
  const clauses = [];
  for (const [queryKey, keyField, column] of [['city_id', 'cityId', columns.city], ['zone_id', 'zoneId', columns.zone], ['ward_id', 'wardId', columns.site], ['sector_id', null, columns.sector]]) {
    for (const value of [keyField ? req.apiKey[keyField] : null, req.query[queryKey]]) {
      if (value === undefined || value === null) continue;
      if (!positive(value)) fail('INVALID_FILTER', `Invalid ${queryKey}.`);
      params.push(Number(value)); clauses.push(`${column}=$${params.length}`);
    }
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}
const siteColumns = { city: 'c.city_id', zone: 'z.zone_id', site: 'w.ward_id', sector: 'w.sector_id' };
const geography = `JOIN wards w ON w.ward_id=COALESCE(a.ward_id,e.ward_id)
  JOIN zones z ON z.zone_id=w.zone_id JOIN cities c ON c.city_id=z.city_id`;
const locationFields = `w.ward_id,w.ward_id AS kothi_id,w.ward_name AS ward,w.ward_name AS kothi,
  w.sector_id,z.zone_id,z.zone_name AS zone,c.city_id,c.city_name AS city`;
const actor = (alias, type, name = `${alias}.name`, photo = `to_jsonb(${alias})->>'profile_photo_url'`) =>
  `CASE WHEN ${alias}.${type === 'user' ? 'user_id' : 'id'} IS NOT NULL THEN jsonb_build_object('id',${alias}.${type === 'user' ? 'user_id' : 'id'}::text,'type','${type}',
   'name',${name},'emp_code',${alias}.emp_code,'phone',${alias}.${type === 'user' ? 'phone' : 'mobile'},'email',${alias}.email,'_photo',${photo}) END`;
const regularSelect = `SELECT a.attendance_id::text AS attendance_id,'regular' AS employee_kind,e.emp_id::text AS employee_id,
  e.emp_id,e.name,e.emp_code,e.phone,${locationFields},des.designation_name AS designation,dept.department_name AS department,
  a.date::date::text AS date,TO_CHAR(a.punch_in_time,'HH24:MI:SS') AS punch_in,TO_CHAR(a.punch_out_time,'HH24:MI:SS') AS punch_out,
  a.punch_in_time,a.punch_out_time,a.mid_shift_punch_in_time,
  TO_CHAR(a.mid_shift_punch_in_time AT TIME ZONE 'Asia/Kolkata','HH24:MI:SS') AS mid_shift_punch_in,
  a.duration,a.leave_type,a.in_address,a.out_address,a.latitude_in,a.longitude_in,a.latitude_out,a.longitude_out,
  to_jsonb(a)->>'mid_in_address' AS mid_in_address,to_jsonb(a)->>'latitude_mid_in' AS latitude_mid_in,to_jsonb(a)->>'longitude_mid_in' AS longitude_mid_in,
  COALESCE(a.auto_punched_out,false) AS is_auto_punch_out,
  a.punch_in_image,a.punch_out_image,a.mid_shift_punch_in_image,
  to_jsonb(a)->>'supervisor_in_by' AS supervisor_in_by,to_jsonb(a)->>'supervisor_out_by' AS supervisor_out_by,
  to_jsonb(a)->>'supervisor_in_name' AS supervisor_in_name,to_jsonb(a)->>'supervisor_out_name' AS supervisor_out_name,
  to_jsonb(a)->>'supervisor_in_capture' AS supervisor_in_capture,to_jsonb(a)->>'supervisor_out_capture' AS supervisor_out_capture,
  to_jsonb(a)->>'register_status' AS register_status,to_jsonb(a)->>'register_request_id' AS register_request_id,
  to_jsonb(a)->>'register_marked_by' AS register_marked_by,to_jsonb(a)->>'register_marked_by_name' AS register_marked_by_name,
  to_jsonb(a)->>'register_marked_at' AS register_marked_at,
  COALESCE(${actor('pi', 'professional', 'pi.full_name', 'pi.selfie_url')},${actor('ui', 'user')}) AS punched_in_by,
  COALESCE(${actor('po', 'professional', 'po.full_name', 'po.selfie_url')},${actor('uo', 'user')}) AS punched_out_by,
  ${actor('um', 'user')} AS mid_shift_punched_in_by,${actor('pr', 'professional', 'pr.full_name', 'pr.selfie_url')} AS register_actor,
  CASE WHEN to_jsonb(a)->>'register_status' IS NOT NULL THEN 'register'
   WHEN to_jsonb(a)->>'supervisor_in_by' IS NOT NULL OR to_jsonb(a)->>'supervisor_out_by' IS NOT NULL THEN 'supervisor' ELSE 'punch' END AS attendance_source,
  CASE WHEN to_jsonb(a)->>'register_status'='present' THEN 'Present' WHEN to_jsonb(a)->>'register_status'='absent' THEN 'Absent'
   WHEN a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL THEN 'Completed'
   WHEN a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL THEN 'In Progress'
   WHEN a.leave_type IS NOT NULL THEN 'On Leave' ELSE 'Absent' END AS status
  FROM attendance a JOIN employee e ON e.emp_id=a.emp_id ${geography}
  LEFT JOIN designation des ON des.designation_id=e.designation_id LEFT JOIN department dept ON dept.department_id=des.department_id
  LEFT JOIN users ui ON ui.user_id=a.punched_in_by LEFT JOIN users uo ON uo.user_id=a.punched_out_by LEFT JOIN users um ON um.user_id=a.mid_shift_punched_in_by
  LEFT JOIN professional_employees pi ON pi.id=(to_jsonb(a)->>'supervisor_in_by')::uuid
  LEFT JOIN professional_employees po ON po.id=(to_jsonb(a)->>'supervisor_out_by')::uuid
  LEFT JOIN professional_employees pr ON pr.id=(to_jsonb(a)->>'register_marked_by')::uuid`;
const professionalSelect = `SELECT pa.id::text AS attendance_id,'professional' AS employee_kind,pe.id::text AS employee_id,
  pe.id AS professional_id,pe.full_name,pe.full_name AS name,pe.emp_code,pe.mobile,pe.mobile AS phone,pe.email,
  pe.city_id,pe.zone_id,pe.ward_id AS sector_id,pe.kothi_id AS ward_id,pe.kothi_id,w.ward_name AS ward,w.ward_name AS kothi,
  c.city_name AS city,c.city_name,z.zone_name AS zone,z.zone_name,
  roles.designation,roles.department,roles.designation_ids,roles.department_ids,
  pa.date::text AS date,TO_CHAR(pa.punch_in AT TIME ZONE 'Asia/Kolkata','HH24:MI:SS') AS punch_in,
  TO_CHAR(pa.punch_out AT TIME ZONE 'Asia/Kolkata','HH24:MI:SS') AS punch_out,pa.punch_in AS punch_in_time,pa.punch_out AS punch_out_time,
  ROUND(EXTRACT(EPOCH FROM (pa.punch_out-pa.punch_in))/3600,2) AS hours_worked,
  pa.attempted_punch_in,pa.punch_approval_status,COALESCE(pa.auto_punched_out,false) AS is_auto_punch_out,
  pa.punch_in_latitude AS latitude_in,pa.punch_in_longitude AS longitude_in,pa.punch_out_latitude AS latitude_out,pa.punch_out_longitude AS longitude_out,
  to_jsonb(pa)->>'in_address' AS in_address,pa.out_address,pa.punch_in_photo_url AS punch_in_image,pa.punch_out_photo_url AS punch_out_image,
  pa.city_id AS original_city_id,pa.zone_id AS original_zone_id,pa.ward_id AS original_sector_id,(to_jsonb(pa)->>'kothi_id')::int AS original_kothi_id,
  CASE WHEN pa.punch_in IS NOT NULL THEN ${actor('pe','professional','pe.full_name','pe.selfie_url')} END AS punched_in_by,
  CASE WHEN pa.punch_out IS NOT NULL THEN ${actor('pe','professional','pe.full_name','pe.selfie_url')} END AS punched_out_by,
  'punch' AS attendance_source,CASE WHEN pa.punch_approval_status='rejected' THEN 'Punch rejected'
   WHEN pa.punch_approval_status LIKE 'pending_%' THEN 'Pending approval'
   WHEN pa.punch_in IS NOT NULL AND pa.punch_out IS NOT NULL THEN 'Completed' WHEN pa.punch_in IS NOT NULL THEN 'In Progress' ELSE 'Absent' END AS status
  FROM professional_attendance pa JOIN professional_employees pe ON pe.id=pa.professional_id
  LEFT JOIN wards w ON w.ward_id=pe.kothi_id LEFT JOIN zones z ON z.zone_id=pe.zone_id LEFT JOIN cities c ON c.city_id=pe.city_id
  LEFT JOIN LATERAL(SELECT string_agg(DISTINCT d.designation_name,', ' ORDER BY d.designation_name) AS designation,
   string_agg(DISTINCT dep.department_name,', ' ORDER BY dep.department_name) AS department,
   array_agg(DISTINCT d.designation_id) AS designation_ids,array_agg(DISTINCT dep.department_id) AS department_ids
   FROM professional_designation_assignments da JOIN designation d ON d.designation_id=da.designation_id
   LEFT JOIN department dep ON dep.department_id=d.department_id WHERE da.professional_id=pe.id) roles ON true`;

async function signedPhoto(reference) {
  if (!reference) return null;
  if (/^https?:\/\//i.test(reference)) {
    const url = new URL(reference);
    const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
    if (!bucket || !(url.hostname === `${bucket}.s3.amazonaws.com` || url.hostname.startsWith(`${bucket}.s3.`))) return reference;
    reference = decodeURIComponent(url.pathname.slice(1));
  }
  return getSignedS3Url(reference, 900);
}
async function images(rows) {
  const cache = new Map();
  const photo = ref => { if (!cache.has(ref)) cache.set(ref, signedPhoto(ref)); return cache.get(ref); };
  for (let i = 0; i < rows.length; i += 10) await Promise.all(rows.slice(i, i + 10).map(async row => {
    for (const [field, type] of [['punch_in_image','IN'],['punch_out_image','OUT'],['mid_shift_punch_in_image','MID_IN']]) {
      row[`${field}_url`] = null;
      if (row[field]) {
        if (row.employee_kind === 'regular') {
          const base = (process.env.EXTERNAL_API_PUBLIC_BASE_URL || 'https://api.matrixtrack.in/api').replace(/\/$/, '');
          const token = issueImageAccess(row.attendance_id, type, row[field]);
          row[`${field}_url`] = `${base}/app/attendance/employee/image?attendance_id=${encodeURIComponent(row.attendance_id)}&punch_type=${type}&image_access=${encodeURIComponent(token)}`;
        } else row[`${field}_url`] = await photo(row[field]);
      }
      delete row[field];
    }
    for (const key of ['punched_in_by','punched_out_by','mid_shift_punched_in_by','register_actor']) {
      if (row[key]) { row[key].photo_url = await photo(row[key]._photo); delete row[key]._photo; }
    }
  }));
  await signSupervisorAttendancePhotos(rows, pool, getSignedS3Url);
  for (const row of rows) {
    // Keep historical actor names even if their account has since been removed.
    row.punched_in_by_name = row.supervisor_in_name || row.punched_in_by?.name || null;
    row.punched_out_by_name = row.supervisor_out_name || row.punched_out_by?.name || null;
    row.register_marked_by_name = row.register_marked_by_name || row.register_actor?.name || null;
  }
  return rows;
}
const endpoint = handler => async (req, res) => {
  try { await handler(req, res); } catch (error) {
    if (!error.status) console.error('[ExternalAPI read]', error.message);
    res.status(error.status || 500).json({ success:false, error:{code:error.status ? error.code : 'SERVER_ERROR',message:error.status ? error.message : 'Unable to load external API data.'} });
  }
};
function attendanceParts(req, kind, range, params) {
  params.push(range.from, range.to);
  const start = params.length - 1, end = params.length;
  if (kind === 'professional') {
    let where = ` WHERE pa.date BETWEEN $${start}::date AND $${end}::date AND pe.is_active=true`;
    where += scope(req, params, {city:'pe.city_id',zone:'pe.zone_id',site:'pe.kothi_id',sector:'pe.ward_id'});
    if (req.query.professional_id) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(req.query.professional_id)) fail('INVALID_FILTER','Invalid professional_id.');
      params.push(req.query.professional_id); where += ` AND pe.id=$${params.length}::uuid`;
    }
    return `${professionalSelect}${where}`;
  }
  let where = ` WHERE a.date::date BETWEEN $${start}::date AND $${end}::date${scope(req, params, siteColumns)}`;
  const employeeId = req.params?.empId || req.query.emp_id;
  if (employeeId !== undefined) {
    if (!positive(employeeId)) fail('INVALID_FILTER','Invalid emp_id.');
    params.push(Number(employeeId)); where += ` AND e.emp_id=$${params.length}`;
  }
  return `${regularSelect}${where}`;
}
function attendanceHandler({ daily=false, kind='regular', full=false, employee=false }={}) {
  return endpoint(async (req, res) => {
    const range = dates(req.query, daily), params=[];
    const page = pagination(req.query);
    const type = full ? req.query.employee_type || 'all' : kind;
    if (!['all','regular','professional'].includes(type)) fail('INVALID_FILTER','employee_type must be all, regular or professional.');
    const source = req.query.source || 'all';
    if (!['all','punch','supervisor','register'].includes(source)) fail('INVALID_FILTER','source must be all, punch, supervisor or register.');
    const parts = (type === 'all' ? ['regular','professional'] : [type]).map(part => `SELECT to_jsonb(r) AS record FROM (${attendanceParts(req,part,range,params)}) r`);
    let sourceFilter='true';
    if(source!=='all'){params.push(source);sourceFilter=`(record->>'attendance_source')=$${params.length}`;}
    const sql = `WITH records AS (${parts.join(' UNION ALL ')}) SELECT record FROM records WHERE ${sourceFilter}`;
    const total = Number((await pool.query(`SELECT count(*) AS total FROM (${sql}) counted`,params)).rows[0].total);
    params.push(page.limit,page.offset);
    const rows = (await pool.query(`${sql} ORDER BY record->>'date',record->>'employee_kind',record->>'employee_id',record->>'attendance_id' LIMIT $${params.length-1} OFFSET $${params.length}`,params)).rows.map(r=>r.record);
    await images(rows);
    res.set('Cache-Control','private, no-store');
    res.json({success:true,data:rows,pagination:{page:page.page,limit:page.limit,total,total_pages:Math.ceil(total/page.limit)},meta:meta(),...(employee?{employee_id:req.params.empId}:{})});
  });
}

const getAttendanceSummary = endpoint(async (req,res) => {
  const {from}=dates(req.query,true),params=[from];
  const where=scope(req,params,siteColumns);
  const result=await pool.query(`SELECT c.city_id,c.city_name,
   COUNT(DISTINCT e.emp_id) FILTER(WHERE to_jsonb(a)->>'register_status'='present' OR a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL) AS total_present,
   COUNT(DISTINCT e.emp_id) FILTER(WHERE a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL) AS total_completed,
   COUNT(DISTINCT e.emp_id) FILTER(WHERE a.punch_in_time IS NOT NULL AND a.punch_out_time IS NULL) AS total_in_progress,
   COUNT(DISTINCT e.emp_id) FILTER(WHERE a.auto_punched_out=true) AS total_auto_punched_out,
   COUNT(DISTINCT e.emp_id) FILTER(WHERE a.leave_type IS NOT NULL AND a.punch_in_time IS NULL) AS total_on_leave,
   COUNT(DISTINCT e.emp_id) FILTER(WHERE to_jsonb(a)->>'register_status'='present') AS total_register_present,
   COUNT(DISTINCT e.emp_id) FILTER(WHERE to_jsonb(a)->>'register_status'='absent') AS total_register_absent
   FROM attendance a JOIN employee e ON e.emp_id=a.emp_id ${geography} WHERE a.date::date=$1::date ${where}
   GROUP BY c.city_id,c.city_name ORDER BY c.city_name,c.city_id`,params);
  res.json({success:true,data:{date:from,cities:result.rows},meta:meta()});
});

// All supervisor assignments are scoped before aggregating into an employee or directory row.
const assignments = `WITH supervisor_sites AS (
 SELECT 'user'::text AS type,user_id::text AS id,ward_id AS site_id FROM user_kothi_access
 UNION SELECT 'user',supervisor_id::text,ward_id FROM supervisor_kothi
 UNION SELECT 'user',sw.supervisor_id::text,COALESCE(direct.ward_id,child.ward_id) FROM supervisor_ward sw
 LEFT JOIN wards direct ON direct.ward_id=sw.ward_id LEFT JOIN wards child ON direct.ward_id IS NULL AND child.sector_id=sw.ward_id
 UNION SELECT 'user',uz.user_id::text,w.ward_id FROM user_zone_access uz JOIN wards w ON w.zone_id=uz.zone_id
 UNION SELECT 'user',uc.user_id::text,w.ward_id FROM user_city_access uc JOIN zones z ON z.city_id=uc.city_id JOIN wards w ON w.zone_id=z.zone_id
  WHERE NOT EXISTS(SELECT 1 FROM user_zone_access uz JOIN zones limited ON limited.zone_id=uz.zone_id WHERE uz.user_id=uc.user_id AND limited.city_id=uc.city_id)
 UNION SELECT 'professional',professional_id::text,kothi_id FROM professional_site_access
 ), supervisors AS (
 SELECT 'user'::text AS type,u.user_id::text AS id,u.name,u.emp_code,u.phone,u.email,to_jsonb(u)->>'profile_photo_url' AS _photo FROM users u
 WHERE u.role='supervisor' AND NOT COALESCE(u.is_deleted,false)
 UNION ALL SELECT 'professional',p.id::text,p.full_name,p.emp_code,p.mobile,p.email,p.selfie_url FROM professional_employees p
 WHERE p.is_active=true AND EXISTS(SELECT 1 FROM professional_designation_assignments da JOIN designation d ON d.designation_id=da.designation_id
  WHERE da.professional_id=p.id AND d.designation_name IN ('Project Manager','Project Head / Site Head'))
 )`;
const supervisorList = `COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.type,s.id) FROM supervisors s
 WHERE EXISTS(SELECT 1 FROM supervisor_sites ss WHERE ss.type=s.type AND ss.id=s.id AND ss.site_id=w.ward_id)),'[]'::jsonb)`;
async function decoratePeople(rows, supervisors=false) {
  for (let i=0;i<rows.length;i+=10) await Promise.all(rows.slice(i,i+10).map(async row=>{
    row[supervisors?'photo_url':'face_image_url']=await signedPhoto(row._photo);delete row._photo;
    if(!supervisors){row.employee_kind=row.attendance_mode==='professional'?'professional':'regular';row.employee_type=row.employee_kind==='professional'?'Professional':'Regular';}
    for(const person of row.supervisors || []){person.photo_url=await signedPhoto(person._photo);delete person._photo;}
  }));
}
const employeesHandler = single => endpoint(async(req,res)=>{
  const params=[],page=pagination(req.query);
  let where=` WHERE true${scope(req,params,siteColumns)}`;
  if(single){if(!positive(req.params.empId))fail('INVALID_FILTER','Invalid emp_id.');params.push(Number(req.params.empId));where+=` AND e.emp_id=$${params.length}`;}
  const from=`FROM employee e JOIN wards w ON w.ward_id=e.ward_id JOIN zones z ON z.zone_id=w.zone_id JOIN cities c ON c.city_id=z.city_id`;
  const total=Number((await pool.query(`SELECT count(*) AS total ${from}${where}`,params)).rows[0].total);
  if(single&&!total)fail('NOT_FOUND','Employee not found or outside your API key scope.',404);
  params.push(page.limit,page.offset);
  const result=await pool.query(`${assignments} SELECT e.emp_id,e.name,e.emp_code,e.phone,${single?'e.aadhar_no,':''}${locationFields},
   des.designation_id,des.designation_name AS designation,dept.department_id,dept.department_name AS department,
   COALESCE((to_jsonb(e)->>'no_personal_phone')::boolean,false) AS no_personal_phone,
   COALESCE((to_jsonb(e)->>'is_active')::boolean,true) AS is_active,COALESCE((to_jsonb(e)->>'is_deleted')::boolean,false) AS is_deleted,
   ${modeFields},(e.face_embedding IS NOT NULL OR saf.photo_key IS NOT NULL) AS face_registered,
   COALESCE(saf.photo_key,e.face_embedding) AS _photo,${supervisorList} AS supervisors
   ${from} LEFT JOIN designation des ON des.designation_id=e.designation_id LEFT JOIN department dept ON dept.department_id=des.department_id
   ${modeJoin}${where} ORDER BY e.name,e.emp_id LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  await decoratePeople(result.rows);res.set('Cache-Control','private, no-store');
  res.json({success:true,data:single?result.rows[0]:result.rows,...(!single?{pagination:{page:page.page,limit:page.limit,total,total_pages:Math.ceil(total/page.limit)}}:{}),meta:meta()});
});
const getSupervisors=endpoint(async(req,res)=>{
  const params=[],page=pagination(req.query),where=scope(req,params,siteColumns);
  const sql=`${assignments}, scoped AS (SELECT s.*,jsonb_agg(DISTINCT jsonb_build_object('city_id',c.city_id,'city',c.city_name,'zone_id',z.zone_id,'zone',z.zone_name,
   'sector_id',w.sector_id,'ward_id',w.ward_id,'ward',w.ward_name)) AS assignments
   FROM supervisors s JOIN supervisor_sites ss ON ss.type=s.type AND ss.id=s.id JOIN wards w ON w.ward_id=ss.site_id
   JOIN zones z ON z.zone_id=w.zone_id JOIN cities c ON c.city_id=z.city_id WHERE true${where}
   GROUP BY s.type,s.id,s.name,s.emp_code,s.phone,s.email,s._photo) SELECT * FROM scoped`;
  const total=Number((await pool.query(`SELECT count(*) AS total FROM (${sql}) counted`,params)).rows[0].total);
  params.push(page.limit,page.offset);
  const result=await pool.query(`${sql} ORDER BY name,type,id LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  await decoratePeople(result.rows,true);res.set('Cache-Control','private, no-store');
  res.json({success:true,data:result.rows,pagination:{page:page.page,limit:page.limit,total,total_pages:Math.ceil(total/page.limit)},meta:meta()});
});
module.exports={getDailyAttendance:attendanceHandler({daily:true}),getAttendanceRange:attendanceHandler(),
 getEmployeeAttendance:attendanceHandler({employee:true}),getProfessionalDailyAttendance:attendanceHandler({daily:true,kind:'professional'}),
 getFullAttendance:attendanceHandler({full:true}),getAttendanceSummary,getEmployees:employeesHandler(false),getEmployeeById:employeesHandler(true),getSupervisors};
