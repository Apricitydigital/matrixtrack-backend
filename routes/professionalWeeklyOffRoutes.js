const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const authenticate = require('../middleware/authMiddleware');
const professionalAuth = require('../middleware/professionalAuth');
const { attachCityScope } = require('../middleware/cityScope');
const { authorize } = require('../middleware/permissionMiddleware');
const { DAYS, DESIGNATIONS, todayIST, parseDay, validateEffectiveDate } = require('../utils/professionalWeeklyOff');
const admin = express.Router();
const app = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const route = handler => async (req, res, next) => { try { await handler(req, res); } catch (e) { if (!e.status) console.error('[WeeklyOff]', e); res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'Unable to process weekly-off request.', errors: e.errors }); } };
const userId = req => req.user.user_id || req.user.id || req.user.userId;
const scope = req => req.cityScope?.all ? null : Array.from(req.cityScope?.ids || []);
admin.use(authenticate, attachCityScope);
admin.use((req,res,next)=>String(req.user?.role).toLowerCase()==='admin' ? next() : res.status(403).json({success:false,message:'Admin access required.'}));
admin.get('/catalog', authorize('professional-weekly-off', 'view'), route(async (req, res) => {
  const cityIds = scope(req);
  const [people, sites, designations] = await Promise.all([
    pool.query(`SELECT p.id, p.full_name, p.emp_code, p.city_id,
      COALESCE((SELECT json_agg(a.designation_id) FROM professional_designation_assignments a WHERE a.professional_id=p.id), '[]') AS designation_ids,
      COALESCE((SELECT json_agg(a.kothi_id) FROM professional_site_access a WHERE a.professional_id=p.id), '[]') AS site_ids
      FROM professional_employees p WHERE p.is_active = TRUE AND ($1::int[] IS NULL OR p.city_id=ANY($1)) ORDER BY p.full_name`, [cityIds]),
    pool.query(`SELECT w.ward_id AS id, w.ward_name AS name, COALESCE(w.zone_id,s.zone_id) AS zone_id, z.zone_name, z.city_id, c.city_name
      FROM wards w LEFT JOIN sectors s ON s.sector_id=w.sector_id JOIN zones z ON z.zone_id=COALESCE(w.zone_id,s.zone_id)
      JOIN cities c ON c.city_id=z.city_id WHERE ($1::int[] IS NULL OR z.city_id=ANY($1)) ORDER BY c.city_name,z.zone_name,w.ward_name`, [cityIds]),
    pool.query(`SELECT d.designation_id AS id,d.designation_name AS name FROM designation d JOIN department dep ON dep.department_id=d.department_id
      WHERE LOWER(TRIM(dep.department_name))='professional' AND d.designation_name=ANY($1::text[]) ORDER BY d.designation_id`, [DESIGNATIONS])
  ]);
  res.json({ success: true, people: people.rows, sites: sites.rows, designations: designations.rows });
}));
admin.put('/assignments/:id', authorize('professional-weekly-off', 'write'), route(async (req, res) => {
  const { designation_ids, site_ids } = req.body;
  if (![designation_ids,site_ids].every(a => Array.isArray(a) && a.every(id => Number.isInteger(id) && id > 0))) fail('Provide valid designation_ids and site_ids arrays.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const person = await client.query(`SELECT id FROM professional_employees WHERE id=$1 AND is_active=TRUE AND ($2::int[] IS NULL OR city_id=ANY($2)) FOR UPDATE`, [req.params.id, scope(req)]);
    if (!person.rows.length) fail('Professional unavailable in your city scope.', 403);
    const valid = await client.query(`SELECT d.designation_id FROM designation d JOIN department dep ON dep.department_id=d.department_id
      WHERE d.designation_id=ANY($1::int[]) AND d.designation_name=ANY($2::text[]) AND LOWER(TRIM(dep.department_name))='professional'`, [designation_ids, DESIGNATIONS]);
    if (valid.rows.length !== new Set(designation_ids).size) fail('Invalid professional designation.');
    const sites = await client.query(`SELECT w.ward_id FROM wards w LEFT JOIN sectors s ON s.sector_id=w.sector_id
      JOIN zones z ON z.zone_id=COALESCE(w.zone_id,s.zone_id) WHERE w.ward_id=ANY($1::int[]) AND ($2::int[] IS NULL OR z.city_id=ANY($2))`, [site_ids,scope(req)]);
    if (sites.rows.length !== new Set(site_ids).size) fail('Site outside your assigned cities.',403);
    // Partial-city admins cannot silently remove an existing assignment in another city.
    const outside = await client.query(`SELECT 1 FROM professional_site_access a JOIN wards w ON w.ward_id=a.kothi_id
      LEFT JOIN sectors s ON s.sector_id=w.sector_id JOIN zones z ON z.zone_id=COALESCE(w.zone_id,s.zone_id)
      WHERE a.professional_id=$1 AND $2::int[] IS NOT NULL AND NOT(z.city_id=ANY($2)) LIMIT 1`, [req.params.id,scope(req)]);
    if (outside.rows.length) fail('This professional has assignments outside your city access; a full-scope admin must edit them.',403);
    await client.query('DELETE FROM professional_designation_assignments WHERE professional_id=$1',[req.params.id]);
    await client.query('DELETE FROM professional_site_access WHERE professional_id=$1',[req.params.id]);
    await client.query(`INSERT INTO professional_designation_assignments(professional_id,designation_id,assigned_by) SELECT $1, id, $3 FROM UNNEST($2::int[]) id ON CONFLICT DO NOTHING`,[req.params.id,designation_ids,userId(req)]);
    await client.query(`INSERT INTO professional_site_access(professional_id,kothi_id,assigned_by) SELECT $1, id, $3 FROM UNNEST($2::int[]) id ON CONFLICT DO NOTHING`,[req.params.id,site_ids,userId(req)]);
    await client.query('COMMIT');
    res.json({success:true,message:'Designations and sites assigned.'});
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally {client.release();}
}));

app.use(professionalAuth);
app.use(async (req,res,next) => { try {
  const {rows} = await pool.query(`SELECT d.designation_name FROM professional_designation_assignments a JOIN designation d ON d.designation_id=a.designation_id WHERE a.professional_id=$1`,[req.professional.professional_id]);
  req.weeklyRoles = rows.map(r=>r.designation_name);
  req.weeklyCanWrite = req.weeklyRoles.includes('HO Coordinator');
  req.weeklyCountry = req.weeklyRoles.includes('Country Head');
  next();
} catch(e) { next(e); } });
app.get('/capabilities', (req,res) => res.json({success:true,designations:req.weeklyRoles,can_manage:req.weeklyCanWrite,can_view:req.weeklyCanWrite || req.weeklyCountry}));
app.use((req,res,next) => req.weeklyCanWrite || req.weeklyCountry ? next() : res.status(403).json({success:false,message:'HO Coordinator or Country Head designation required.'}));
const requireWriter = (req,res,next) => req.weeklyCanWrite ? next() : res.status(403).json({success:false,message:'HO Coordinator designation required to change weekly offs.'});
async function employees(req, client=pool, lock=false) {
  const site = req.query.site_id;
  if (site && (!/^\d+$/.test(String(site)) || Number(site)<1)) fail('Invalid site.');
  if(site) {
    const access = await client.query('SELECT 1 FROM professional_site_access WHERE professional_id=$1 AND kothi_id=$2',[req.professional.professional_id,site]);
    if(!access.rows.length) fail('Site is not assigned to you.',403);
  }
  const {rows} = await client.query(`SELECT p.id,p.full_name,p.emp_code,p.kothi_id,w.ward_name AS site_name,c.city_name,z.zone_name,
    EXISTS(SELECT 1 FROM professional_site_access a WHERE a.professional_id=$1 AND a.kothi_id=p.kothi_id) AS can_manage,
    professional_week_off_days_at(p.id,$3::date) AS week_off_days,
    (SELECT COUNT(*)::int FROM professional_week_off_versions v WHERE v.professional_id=p.id AND v.source<>'legacy') AS update_count
    FROM professional_employees p LEFT JOIN wards w ON w.ward_id=p.kothi_id LEFT JOIN cities c ON c.city_id=p.city_id LEFT JOIN zones z ON z.zone_id=p.zone_id
    WHERE p.is_active=TRUE AND EXISTS (SELECT 1 FROM professional_site_access a WHERE a.professional_id=$1 AND a.kothi_id=p.kothi_id)
      AND ($2::int IS NULL OR p.kothi_id=$2) ORDER BY p.full_name ${lock ? 'FOR UPDATE OF p' : ''}`,
    [req.professional.professional_id,site || null,todayIST()]);
  return rows;
}
app.get('/sites',route(async(req,res)=>{
  const {rows} = await pool.query(`SELECT w.ward_id AS id,w.ward_name AS name,c.city_name,z.zone_name,
    EXISTS (SELECT 1 FROM professional_site_access a WHERE a.professional_id=$1 AND a.kothi_id=w.ward_id) AS can_manage FROM wards w
    LEFT JOIN sectors s ON s.sector_id=w.sector_id JOIN zones z ON z.zone_id=COALESCE(w.zone_id,s.zone_id) JOIN cities c ON c.city_id=z.city_id
    WHERE EXISTS (SELECT 1 FROM professional_site_access a WHERE a.professional_id=$1 AND a.kothi_id=w.ward_id)
    ORDER BY c.city_name,z.zone_name,w.ward_name`,[req.professional.professional_id]);
  res.json({success:true,data:rows});
}));
app.get('/employees',route(async(req,res)=>res.json({success:true,data:await employees(req)})));
app.get('/dashboard',route(async(req,res)=>{
  const rows=await employees(req);
  const today=new Date(`${todayIST()}T00:00:00Z`).getUTCDay();
  const coordinators=await pool.query(`SELECT v.actor_professional_id AS id,a.full_name,COUNT(*)::int AS update_count FROM professional_week_off_versions v
    JOIN professional_employees a ON a.id=v.actor_professional_id WHERE v.professional_id=ANY($1::uuid[]) AND v.source='coordinator'
    GROUP BY v.actor_professional_id,a.full_name ORDER BY update_count DESC,a.full_name`,[rows.map(p=>p.id)]);
  res.json({success:true,data:{employee_count:rows.length,today_weekly_off:rows.filter(p=>p.week_off_days.includes(today)).length,
    by_day:DAYS.map((day,i)=>({day,count:rows.filter(p=>p.week_off_days.includes(i)).length})),
    total_updates:rows.reduce((sum,p)=>sum+p.update_count,0),coordinators:coordinators.rows}});
}));
app.get('/history',route(async(req,res)=>{
  const allowed=await employees(req);
  const ids=allowed.map(p=>p.id);
  const {rows}=await pool.query(`SELECT v.id,v.professional_id,p.full_name,p.emp_code,w.ward_name AS site_name,v.week_off_days,v.old_days,v.effective_from::text,v.created_at,
    COALESCE(actor.full_name,u.name,'Legacy') AS actor_name,v.source
    FROM professional_week_off_versions v JOIN professional_employees p ON p.id=v.professional_id LEFT JOIN wards w ON w.ward_id=p.kothi_id
    LEFT JOIN professional_employees actor ON actor.id=v.actor_professional_id LEFT JOIN users u ON u.user_id=v.actor_user_id
    WHERE v.professional_id=ANY($1::uuid[]) AND v.source<>'legacy' ORDER BY v.id DESC LIMIT 500`,[ids]);
  res.json({success:true,data:rows});
}));
app.get('/template',route(async(req,res)=>{
  const rows=await employees(req);
  const workbook=new ExcelJS.Workbook();
  const sheet=workbook.addWorksheet('Weekly Off');
  sheet.columns=[{header:'Employee Name',key:'name',width:30},{header:'Employee ID',key:'id',width:40},{header:'Assigned Site',key:'site',width:35},{header:'Weekly-Off Day',key:'day',width:20}];
  rows.forEach(p=>sheet.addRow({name:p.full_name,id:p.emp_code || p.id,site:p.site_name || '',day:p.week_off_days.map(d=>DAYS[d]).join(', ')}));
  sheet.getRow(1).font={bold:true};
  sheet.views=[{state:'frozen',ySplit:1}];
  for(let i=2;i<=Math.max(rows.length+1,2);i++) sheet.getCell(i,4).dataValidation={type:'list',allowBlank:true,formulae:[`"${DAYS.join(',')}"`]};
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="weekly-off-template.xlsx"');
  await workbook.xlsx.write(res);res.end();
}));
async function save(req, changes) {
  const effective=validateEffectiveDate(req.body.effective_from);
  if(!Array.isArray(changes) || !changes.length || changes.length>10000) fail('Supply between 1 and 10,000 employee rows.');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the coordinator row as assignment updates lock the same row.
    const actor=await client.query('SELECT id FROM professional_employees WHERE id=$1 AND is_active=TRUE FOR UPDATE',[req.professional.professional_id]);
    if(!actor.rows.length) fail('Professional account is inactive.',403);
    const roles=await client.query(`SELECT 1 FROM professional_designation_assignments a JOIN designation d ON d.designation_id=a.designation_id WHERE a.professional_id=$1 AND d.designation_name='HO Coordinator'`,[req.professional.professional_id]);
    if(!roles.rows.length) fail('HO Coordinator designation no longer assigned.',403);
    // Every designation is restricted to its explicitly assigned sites.
    const allowed=await employees(req,client,true);
    const identities=new Map();
    for(const person of allowed) for(const key of new Set([person.id,String(person.emp_code || '').trim()].filter(Boolean))) {
      identities.set(key,[...(identities.get(key) || []),person]);
    }
    const seen=new Set();const errors=[];const parsed=[];
    for(let i=0;i<changes.length;i++) {
      const row=changes[i];
      try {
        const identifier=String(row.employee_id ?? '').trim();
        const matches=identities.get(identifier) || [];
        if(matches.length!==1) fail('Employee ID is unknown, ambiguous, inactive or outside assigned sites.');
        const person=matches[0];
        if(seen.has(person.id)) fail('Duplicate employee row.');
        if(row.assigned_site !== undefined && String(row.assigned_site).trim() !== String(person.site_name || '').trim()) fail('Assigned Site does not match this employee.');
        const day=parseDay(row.week_off_day);
        seen.add(person.id);parsed.push({person,day});
      } catch(e) {errors.push({row:i+2,employee_id:row.employee_id,message:e.message});}
    }
    if(errors.length) throw Object.assign(new Error('Upload rejected. Correct the listed rows; no weekly offs were changed.'),{status:400,errors});
    for(const {person,day} of parsed) {
      await client.query(`INSERT INTO professional_week_off(professional_id,week_off_days,effective_from,updated_by_professional,updated_at)
        VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(professional_id) DO UPDATE SET week_off_days=EXCLUDED.week_off_days,effective_from=EXCLUDED.effective_from,
        updated_by_professional=EXCLUDED.updated_by_professional,updated_by=NULL,updated_at=NOW()`,[person.id,[day],effective,req.professional.professional_id]);
    }
    await client.query('COMMIT');return {updated:parsed.length,effective_from:effective};
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}
app.put('/employees',requireWriter,route(async(req,res)=>res.json({success:true,...await save(req,req.body.rows)})));
app.post('/upload',requireWriter,upload.single('file'),route(async(req,res)=>{
  if(!req.file || !/\.xlsx$/i.test(req.file.originalname)) fail('Upload an .xlsx template.');
  const workbook=new ExcelJS.Workbook();
  try {await workbook.xlsx.load(req.file.buffer);} catch(e) {fail('Invalid Excel workbook.');}
  const sheet=workbook.getWorksheet('Weekly Off') || workbook.worksheets[0];
  if(!sheet || sheet.rowCount>10001) fail('Template missing or exceeds 10,000 rows.');
  const headers=['Employee Name','Employee ID','Assigned Site','Weekly-Off Day'];
  if(!headers.every((h,i)=>sheet.getRow(1).getCell(i+1).text.trim()===h)) fail('Use the downloaded template with unchanged column headers.');
  const rows=[];
  sheet.eachRow((row,i)=>{if(i>1 && row.values.some(v=>v!==null && v!==undefined && String(v).trim())) rows.push({employee_id:row.getCell(2).text,assigned_site:row.getCell(3).text,week_off_day:row.getCell(4).text});});
  res.json({success:true,...await save(req,rows)});
}));
app.use((error,req,res,next)=>{res.status(error instanceof multer.MulterError ? 400 : 500).json({success:false,message:error instanceof multer.MulterError ? 'Upload must be one file smaller than 5 MB.' : 'Unable to load weekly-off access.'});});
module.exports={admin,app};
