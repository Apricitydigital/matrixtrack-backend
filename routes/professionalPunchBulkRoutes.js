const router=require('express').Router();
const multer=require('multer');
const ExcelJS=require('exceljs');
const pool=require('../config/db');
const authenticate=require('../middleware/authMiddleware');
const {attachCityScope}=require('../middleware/cityScope');
const {authorize,getPermissionCityFilter}=require('../middleware/permissionMiddleware');
const {ensurePunchCutoffSchema}=require('../utils/professionalPunchCutoff');
const {HEADERS,parseCutoff,plainCell}=require('../utils/professionalPunchImport');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1}});
const fail=(message,status=400,errors)=>{throw Object.assign(new Error(message),{status,errors});};
const wrap=handler=>async(req,res)=>{try {await handler(req,res);} catch(e) {
  if(!e.status) console.error('[PunchBulk]',e);
  res.status(e.status || 500).json({success:false,message:e.status ? e.message : 'Unable to process punch-in times.',errors:e.errors});
}};
const userId=req=>req.user.user_id || req.user.id || req.user.userId;
router.use(authenticate);
router.use(async(req,res,next)=>{try {
  const {rows}=await pool.query('SELECT role,email,permissions,is_deleted FROM users WHERE user_id=$1',[userId(req)]);
  const user=rows[0];
  if(!user || user.is_deleted===true || !['admin','super_admin'].includes(user.role) || user.permissions?.is_active===false) return res.status(403).json({success:false,message:'Active admin account required.'});
  const ownerEmails=[process.env.SUPER_ADMIN_EMAIL || 'mtadmin@apricitydigital.in',process.env.SUPER_ADMIN_DB_EMAIL || 'admin@gmail.com'].map(e=>e.trim().toLowerCase());
  const owner=user.role==='super_admin' || ownerEmails.includes(String(user.email || '').trim().toLowerCase());
  // Resolve city assignments from current DB permissions, rather than stale JWT claims.
  req.user={...req.user,role:user.role==='super_admin' ? 'admin' : user.role,permissions:owner ? {...user.permissions,role_type:'super_admin'} : user.permissions};
  await ensurePunchCutoffSchema();next();
} catch(e) {console.error('[PunchBulk]',e);res.status(500).json({success:false,message:'Unable to validate admin access.'});}});
router.use(attachCityScope);
const permit=action=>(req,res,next)=>req.user.permissions?.role_type==='super_admin' ? next() : authorize('professional-punch-time',action)(req,res,next);
const scope=req=>getPermissionCityFilter(req,'professional-punch-time',req.punchAction || 'view');
const permission=action=>(req,res,next)=>{req.punchAction=action;return permit(action)(req,res,next);};
function filters(req) {
  const parse=(value,label)=>{
    if(value===undefined || value==='') return null;
    if(!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<1) fail(`Invalid ${label}.`);
    return Number(value);
  };
  const city=parse(req.query.city_id,'city'),site=parse(req.query.site_id,'site');
  const cities=scope(req);
  if(city && cities!==null && !cities.includes(city)) fail('City is outside your assigned access.',403);
  return {city,site,cities};
}
async function people(req,client=pool,lock=false) {
  const {city,site,cities}=filters(req);
  const {rows}=await client.query(`SELECT p.id,p.emp_code,p.full_name,p.city_id,p.kothi_id AS site_id,
    c.city_name,w.ward_name AS site_name,z.zone_name,t.cutoff_time::text,t.updated_at,
    COALESCE(actor.full_name,u.name) AS updated_by_name
    FROM professional_employees p LEFT JOIN cities c ON c.city_id=p.city_id
    LEFT JOIN wards w ON w.ward_id=p.kothi_id LEFT JOIN zones z ON z.zone_id=p.zone_id
    LEFT JOIN professional_punch_cutoffs t ON t.professional_id=p.id
    LEFT JOIN professional_employees actor ON actor.id=t.updated_by LEFT JOIN users u ON u.user_id=t.updated_by_user
    WHERE p.is_active=TRUE AND ($1::int[] IS NULL OR p.city_id=ANY($1))
      AND ($2::int IS NULL OR p.city_id=$2) AND ($3::int IS NULL OR p.kothi_id=$3)
    ORDER BY p.id ${lock ? 'FOR UPDATE OF p' : ''}`,[cities,city,site]);
  return rows;
}
router.get('/catalog',permission('view'),wrap(async(req,res)=>{
  const data=await people(req);
  const cities=await pool.query('SELECT city_id AS id,city_name AS name FROM cities WHERE ($1::int[] IS NULL OR city_id=ANY($1)) ORDER BY city_name',[scope(req)]);
  // Site options follow visible employees, preventing cross-city directory leakage.
  const allPeople=await people({...req,query:{}});
  const sites=[...new Map(allPeople.filter(p=>p.site_id).map(p=>[p.site_id,{id:p.site_id,name:p.site_name,city_id:p.city_id,city_name:p.city_name}])).values()];
  data.sort((a,b)=>a.full_name.localeCompare(b.full_name));
  res.json({success:true,data,cities:cities.rows,sites});
}));
router.put('/employees/:employee',permission('write'),wrap(async(req,res)=>{
  const employee=req.params.employee;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employee)) fail('Invalid employee.');
  const time=req.body.cutoff_time;
  if(typeof time!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('Use a valid 24-hour time: HH:mm.');
  const {city,site,cities}=filters(req);
  let client;
  try {
    client=await pool.connect();await client.query('BEGIN');
    const person=await client.query(`SELECT id FROM professional_employees
      WHERE id=$1 AND is_active=TRUE AND ($2::int[] IS NULL OR city_id=ANY($2))
        AND ($3::int IS NULL OR city_id=$3) AND ($4::int IS NULL OR kothi_id=$4) FOR UPDATE`,[employee,cities,city,site]);
    if(!person.rows.length) fail('Employee is inactive or outside your selected access.',403);
    const old=await client.query('SELECT cutoff_time FROM professional_punch_cutoffs WHERE professional_id=$1',[employee]);
    await client.query(`INSERT INTO professional_punch_cutoffs(professional_id,cutoff_time,updated_by_user) VALUES($1,$2,$3)
      ON CONFLICT(professional_id) DO UPDATE SET cutoff_time=EXCLUDED.cutoff_time,updated_by=NULL,updated_by_user=EXCLUDED.updated_by_user,updated_at=NOW()`,[employee,time,userId(req)]);
    await client.query(`INSERT INTO professional_punch_activity(professional_id,actor_user_id,action,old_time,new_time) VALUES($1,$2,'set_time',$3,$4)`,[employee,userId(req),old.rows[0]?.cutoff_time || null,time]);
    await client.query('COMMIT');res.json({success:true,message:'Punch-in cutoff saved (IST).'});
  } catch(e) {if(client) await client.query('ROLLBACK');throw e;} finally {client?.release();}
}));
async function readFile(req) {
  if(!req.file || !/\.xlsx$/i.test(req.file.originalname)) fail('Upload a single .xlsx file (maximum 5 MB).');
  const workbook=new ExcelJS.Workbook();
  try {await workbook.xlsx.load(req.file.buffer);} catch(e) {fail('Invalid Excel workbook.');}
  const sheets=workbook.worksheets.filter(s=>!['instructions','city & site reference'].includes(s.name.trim().toLowerCase()));
  if(!sheets.length) fail('Employee sheet missing.');
  const rows=[];let total=0;
  for(const sheet of sheets) {
    total+=sheet.rowCount-1;
    if(total>10000) fail('Maximum 10,000 employee rows per upload.');
    if(!HEADERS.every((h,i)=>sheet.getRow(1).getCell(i+1).text.trim()===h)) fail(`Sheet "${sheet.name}" has invalid headers. Use the downloaded template.`);
    sheet.eachRow((row,i)=>{
      if(i===1 || !row.values.some(v=>v!==null && v!==undefined && String(v).trim())) return;
      const location={sheet:sheet.name,row:i};
      try {
        rows.push({...location,code:String(plainCell(row.getCell(1)) ?? '').trim(),name:String(plainCell(row.getCell(2)) ?? '').trim(),city_id:plainCell(row.getCell(3)),city_name:String(plainCell(row.getCell(4)) ?? '').trim(),site_id:plainCell(row.getCell(5)),site_name:String(plainCell(row.getCell(6)) ?? '').trim(),cutoff_time:parseCutoff(plainCell(row.getCell(7)))});
      } catch(e) {rows.push({...location,error:e.message,code:row.getCell(1).text.trim()});}
    });
  }
  if(!rows.length) fail('The workbook contains no employee rows.');
  return rows;
}
function validate(rows,allowed) {
  const lookup=new Map();const seen=new Set();const errors=[];const changes=[];
  for(const person of allowed) {
    const code=String(person.emp_code || '').trim().toUpperCase();
    if(code) lookup.set(code,[...(lookup.get(code) || []),person]);
  }
  for(const row of rows) {
    try {
      if(row.error) fail(row.error);
      if(!row.code) fail('Employee Code is required.');
      for(const field of ['city_id','site_id']) if(row[field]!=='' && row[field]!==null && row[field]!==undefined && (!/^\d+$/.test(String(row[field])) || Number(row[field])<1)) fail(`Invalid ${field.replace('_',' ')}.`);
      const matches=(lookup.get(row.code.toUpperCase()) || []).filter(p=>(!row.city_id || Number(row.city_id)===p.city_id) && (!row.site_id || Number(row.site_id)===p.site_id));
      if(matches.length!==1) fail('Code is unknown, inactive, outside your selected scope or ambiguous. Use City ID and Site ID to identify duplicate codes.');
      const person=matches[0];
      if(seen.has(person.id)) fail('Duplicate employee row; submit each employee only once.');
      for(const [field,actual] of [['name',person.full_name],['city_name',person.city_name],['site_name',person.site_name]]) if(row[field] && row[field]!==String(actual || '').trim()) fail(`${field.replace('_',' ')} does not match the employee.`);
      seen.add(person.id);changes.push({id:person.id,emp_code:person.emp_code,full_name:person.full_name,city_name:person.city_name,site_name:person.site_name,old_time:person.cutoff_time?.slice(0,5) || null,new_time:row.cutoff_time});
    } catch(e) {errors.push({sheet:row.sheet,row:row.row,employee_code:row.code,message:e.message});}
  }
  if(errors.length) fail('Import rejected. Correct all listed rows; no cutoff times were changed.',400,errors);
  return changes;
}
router.post('/preview',permission('write'),upload.single('file'),wrap(async(req,res)=>{
  const rows=await readFile(req);
  const changes=validate(rows,await people(req));
  res.json({success:true,data:changes,updated:changes.length});
}));
router.post('/import',permission('write'),upload.single('file'),wrap(async(req,res)=>{
  const rows=await readFile(req);let client;
  try {
    client=await pool.connect();await client.query('BEGIN');
    const changes=validate(rows,await people(req,client,true));
    for(const change of changes) {
      await client.query(`INSERT INTO professional_punch_cutoffs(professional_id,cutoff_time,updated_by_user) VALUES($1,$2,$3)
        ON CONFLICT(professional_id) DO UPDATE SET cutoff_time=EXCLUDED.cutoff_time,updated_by=NULL,updated_by_user=EXCLUDED.updated_by_user,updated_at=NOW()`,[change.id,change.new_time,userId(req)]);
      await client.query(`INSERT INTO professional_punch_activity(professional_id,actor_user_id,action,old_time,new_time) VALUES($1,$2,'set_time',$3,$4)`,[change.id,userId(req),change.old_time,change.new_time]);
    }
    await client.query('COMMIT');res.json({success:true,updated:changes.length,message:'Employee punch-in cutoff times imported (IST).'});
  } catch(e) {if(client) await client.query('ROLLBACK');throw e;} finally {client?.release();}
}));
function employeeSheet(workbook,name,rows) {
  const sheet=workbook.addWorksheet(name);
  sheet.columns=HEADERS.map((header,i)=>({header,width:[20,30,12,24,12,30,27][i]}));
  for(const p of rows) sheet.addRow([String(p.emp_code || ''),p.full_name,p.city_id || '',p.city_name || '',p.site_id || '',p.site_name || '',p.cutoff_time?.slice(0,5) || '']);
  sheet.getColumn(1).numFmt='@';sheet.getColumn(7).numFmt='@';
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}};
  sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:'A1',to:`G${Math.max(1,rows.length+1)}`};
  return sheet;
}
router.get('/download',permission('view'),wrap(async(req,res)=>{
  const rows=await people(req);rows.sort((a,b)=>a.full_name.localeCompare(b.full_name));
  const group=req.query.group_by || 'none';
  if(!['none','city','site'].includes(group)) fail('Invalid download grouping.');
  const workbook=new ExcelJS.Workbook();
  if(group==='none' || !rows.length) employeeSheet(workbook,'Punch-in Times',rows);
  else {
    const groups=new Map();
    for(const row of rows) {
      const key=group==='city' ? row.city_id : row.site_id;
      if(!groups.has(key)) groups.set(key,[]);groups.get(key).push(row);
    }
    for(const [key,employees] of groups) {
      const label=group==='city' ? employees[0].city_name : employees[0].site_name;
      // IDs keep sheet names unique, even for repeated site/city names.
      const prefix=`${group==='city' ? 'C' : 'S'}${key || 0} `;
      const name=(prefix+String(label || 'Unassigned').replace(/[\\/*?:\[\]']/g,' ').slice(0,31-prefix.length)).trim();
      employeeSheet(workbook,name,employees);
    }
  }
  const reference=workbook.addWorksheet('City & Site Reference');
  reference.columns=[
    {header:'City ID',width:12},{header:'City Name',width:25},{header:'Project Name',width:28},
    {header:'Site ID',width:12},{header:'Site Name',width:35},
  ];
  const mappings=[...new Map(rows.map(p=>[`${p.city_id || ''}:${p.site_id || ''}`,p])).values()]
    .sort((a,b)=>String(a.city_name || '').localeCompare(String(b.city_name || '')) || String(a.site_name || '').localeCompare(String(b.site_name || '')));
  for(const p of mappings) reference.addRow([p.city_id || '',p.city_name || '',p.zone_name || '',p.site_id || '',p.site_name || 'Unassigned']);
  reference.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  reference.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}};
  reference.views=[{state:'frozen',ySplit:1}];
  reference.autoFilter={from:'A1',to:`E${Math.max(1,mappings.length+1)}`};
  const info=workbook.addWorksheet('Instructions');
  info.getColumn(1).width=110;
  ['Update existing professional employees using Employee Code and Punch-in Cutoff (IST).',
    'Cutoff is the latest allowed punch-in time, not the shift punch-out time. Use HH:mm (24-hour IST).',
    'Keep headers unchanged. City/Site IDs identify duplicate employee codes. Context names may be left blank.',
    'City & Site Reference lists city codes, project names and site codes/names for this download selection. It is ignored during import.',
    'Codes with leading zeros must stay text. Use plain values instead of formulas.',
    'Every employee sheet is imported. Remove unused employee rows; blank cutoff times are rejected.',
    'Only active employees in your assigned cities and selected city/site can be updated.',
    'Times affect new punches when the Superadmin restriction is ON. Existing requests retain their snapshot.',
    'Maximum 10,000 rows and a 5 MB .xlsx file. An invalid row rejects the entire batch.'].forEach(line=>info.addRow([line]));
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="professional-punch-times.xlsx"');
  await workbook.xlsx.write(res);res.end();
}));
router.get('/history',permission('view'),wrap(async(req,res)=>{
  const allowed=await people(req);
  const {rows}=await pool.query(`SELECT l.id,l.created_at,l.old_time::text,l.new_time::text,p.emp_code,p.full_name,c.city_name,w.ward_name AS site_name,
    COALESCE(a.full_name,u.name) AS actor_name,CASE WHEN l.actor_user_id IS NOT NULL THEN 'Admin' ELSE 'Professional' END AS actor_type
    FROM professional_punch_activity l JOIN professional_employees p ON p.id=l.professional_id
    LEFT JOIN professional_employees a ON a.id=l.actor_id LEFT JOIN users u ON u.user_id=l.actor_user_id
    LEFT JOIN cities c ON c.city_id=p.city_id LEFT JOIN wards w ON w.ward_id=p.kothi_id
    WHERE l.professional_id=ANY($1::uuid[]) AND l.action='set_time' ORDER BY l.id DESC LIMIT 500`,[allowed.map(p=>p.id)]);
  res.json({success:true,data:rows});
}));
router.use((e,req,res,next)=>{console.error('[PunchBulk]',e);res.status(e instanceof multer.MulterError ? 400 : 500).json({success:false,message:e instanceof multer.MulterError ? 'Upload a single file smaller than 5 MB.' : 'Unable to process the workbook.'});});
module.exports=router;
