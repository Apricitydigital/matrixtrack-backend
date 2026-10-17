const router = require('express').Router();
const pool = require('../config/db');
const auth = require('../middleware/authMiddleware');
const { attachCityScope } = require('../middleware/cityScope');
const { authorize, getPermissionCityFilter } = require('../middleware/permissionMiddleware');
const { fetchUserKothiAccess } = require('../utils/userKothiAccess');
const { ensureProfessionalLeaveSchema } = require('../utils/professionalLeaveSchema');
const moduleName = 'professional-holiday-declare';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const wrap = handler => async (req,res) => {
  try { await handler(req,res); }
  catch(error) {
    if (!error.status && error.code !== '23505') console.error('[ProfessionalHolidays]',error);
    res.status(error.status || (error.code === '23505' ? 409 : 500)).json({success:false,message:error.status ? error.message : error.code === '23505' ? 'A holiday already exists for one of these sites and this date. No changes saved.' : 'Unable to process professional holidays.'});
  }
};
router.use(auth, attachCityScope);
const access = action => [authorize(moduleName,action), async(req,res,next)=>{
  try {
    await ensureProfessionalLeaveSchema();
    const scope = await fetchUserKothiAccess(req.user,{allowZoneFallback:true,allowCityFallback:true});
    req.holidaySiteIds = scope.all ? null : scope.ids || [];
    req.holidayCityIds = getPermissionCityFilter(req,moduleName,action);
    next();
  } catch(error) { console.error('[HolidayAccess]',error);res.status(500).json({success:false,message:'Unable to validate holiday access.'}); }
}];
async function sites(req,client=pool) {
  return (await client.query(`SELECT w.ward_id AS id,w.ward_name AS name,c.city_id,c.city_name,z.zone_name,s.sector_name
    FROM wards w LEFT JOIN sectors s ON s.sector_id=w.sector_id JOIN zones z ON z.zone_id=COALESCE(w.zone_id,s.zone_id)
    JOIN cities c ON c.city_id=z.city_id WHERE ($1::int[] IS NULL OR w.ward_id=ANY($1))
    AND ($2::int[] IS NULL OR c.city_id=ANY($2)) ORDER BY c.city_name,w.ward_name,w.ward_id`,[req.holidaySiteIds,req.holidayCityIds])).rows;
}
async function transaction(handler) {
  const client=await pool.connect();
  try {await client.query('BEGIN');const result=await handler(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function log(client,row,action,actor) {
  const name=(await client.query('SELECT name FROM users WHERE user_id=$1',[actor])).rows[0]?.name || 'Unknown';
  await client.query(`INSERT INTO professional_holiday_logs(holiday_id,action,actor_user_id,actor_name,holiday_date,holiday_name,description,city_id,zone_id,ward_id,kothi_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[row.id,action,actor,name,row.holiday_date,row.holiday_name,row.description,row.city_id,row.zone_id,row.ward_id,row.kothi_id]);
}
router.get('/sites',...access('view'),wrap(async(req,res)=>res.json({success:true,data:await sites(req)})));
const list = history => wrap(async(req,res)=>{
  const month=String(req.query.month || '');const site=String(req.query.site || '');
  if(month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('Choose a valid month.');
  if(site && (!/^\d+$/.test(site)||!Number.isSafeInteger(Number(site))||Number(site)<1))fail('Choose a valid site.');
  const allowed=await sites(req);const ids=allowed.map(s=>s.id);
  if(site&&!ids.includes(Number(site)))fail('Site outside your assigned access.',403);
  const {rows}=await pool.query(`SELECT h.*,h.holiday_date::text AS holiday_date,w.ward_name AS site_name,c.city_name,
    ${history ? 'h.actor_name,h.created_at AS action_at' : 'u.name AS created_by_name'}
    FROM ${history ? 'professional_holiday_logs' : 'professional_holidays'} h
    LEFT JOIN wards w ON w.ward_id=h.kothi_id LEFT JOIN cities c ON c.city_id=h.city_id
    ${history ? '' : 'LEFT JOIN users u ON u.user_id=h.created_by'}
    WHERE h.kothi_id=ANY($1::int[]) AND ($2::text='' OR to_char(h.holiday_date,'YYYY-MM')=$2)
    AND ($3::int IS NULL OR h.kothi_id=$3) AND ($4::int[] IS NULL OR h.city_id=ANY($4))
    ORDER BY ${history ? 'h.created_at DESC,h.id DESC' : 'h.holiday_date DESC,w.ward_name,h.id'} LIMIT 501`,[ids,month,site||null,req.holidayCityIds]);
  res.json({success:true,data:rows.slice(0,500),truncated:rows.length>500});
});
router.get('/',...access('view'),list(false));
router.get('/history',...access('view'),list(true));
router.post('/',...access('write'),wrap(async(req,res)=>{
  const {site_ids:ids,holiday_date:date}=req.body;
  const name=String(req.body.holiday_name||'').trim();const description=String(req.body.description||'').trim();
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||!ids.every(id=>Number.isInteger(id)&&id>0)||new Set(ids).size!==ids.length)fail('Select between 1 and 1000 unique sites.');
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'1900-01-01'||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)fail('Choose a valid holiday date.');
  if(!name||name.length>120||description.length>2000)fail('Enter a holiday name up to 120 characters and description up to 2000.');
  const result=await transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('professional-holiday-declarations'))");
    const allowed=await sites(req,client);const byId=new Map(allowed.map(s=>[s.id,s]));
    if(ids.some(id=>!byId.has(id)))fail('One or more sites are outside your assigned access. No changes saved.',403);
    const duplicate=await client.query('SELECT kothi_id FROM professional_holidays WHERE kothi_id=ANY($1::int[]) AND holiday_date=$2',[ids,date]);
    if(duplicate.rows.length)fail('Holiday already declared for '+duplicate.rows.map(r=>byId.get(r.kothi_id).name).join(', ')+' on '+date+'. No changes saved.',409);
    const created=[];const actor=req.user.user_id||req.user.id||req.user.userId;
    for(const id of ids){const site=byId.get(id);const row=(await client.query(`INSERT INTO professional_holidays(holiday_date,holiday_name,description,city_id,kothi_id,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *,holiday_date::text AS holiday_date`,[date,name,description||null,site.city_id,id,actor])).rows[0];await log(client,row,'created',actor);created.push(row);}
    return created;
  });
  res.status(201).json({success:true,data:result,message:`Holiday declared for ${result.length} sites.`});
}));
router.delete('/:id',...access('write'),wrap(async(req,res)=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id))fail('Invalid holiday ID.');
  await transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('professional-holiday-declarations'))");
    const allowed=await sites(req,client);
    const row=(await client.query('SELECT *,holiday_date::text AS holiday_date FROM professional_holidays WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(!row||!allowed.some(s=>s.id===row.kothi_id&&s.city_id===row.city_id))fail('Holiday unavailable in your assigned sites.',403);
    await log(client,row,'deleted',req.user.user_id||req.user.id||req.user.userId);
    await client.query('DELETE FROM professional_holidays WHERE id=$1',[row.id]);
  });
  res.json({success:true,message:'Holiday removed. History is preserved.'});
}));
module.exports=router;
