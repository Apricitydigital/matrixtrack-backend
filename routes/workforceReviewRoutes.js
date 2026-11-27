const {reviewIdentity,assertSameAadhaar}=require('../utils/workforceAadhaar');
const {pairKey,exclusions}=require('../utils/workforceNonDuplicates');
const router = require('express').Router();
const pool = require('../config/db');
const authenticate = require('../middleware/authMiddleware');
const { attachCityScope } = require('../middleware/cityScope');
const { authorize, getPermissionCityFilter } = require('../middleware/permissionMiddleware');
const { fetchUserKothiAccess } = require('../utils/userKothiAccess');
const { recordsSql, summarize, deletionPlan, fingerprint, quote } = require('../utils/workforceReview');
const {reviewDuplicateCandidates,matchingSignals,mergePlan,moveReferences,validateMove,assertAliasTriggers}=require('../utils/workforceMerge');
const {ensureMergeSchema}=require('../utils/employeeAliases');
const {retainMergedLogins}=require('../utils/selfAttendanceMergeLogin');
const recovery=require('../utils/workforceMergeRecovery');
const crossAttendance=require('../utils/workforceCrossAttendance');
const {workforceBlockDetails}=require('../utils/workforceBlockDetails');
const HR_MERGE_ADMIN_EMAIL='hr@apricitydigital.in';
const HR_HARD_DELETE_ADMIN_EMAIL='hr@humanmatrix.co.in';
const fail = (message, status=400) => { throw Object.assign(new Error(message), { status }); };
const wrap = fn => async (req,res,next) => { try { await fn(req,res,next); } catch(e) {
 console.error('[WorkforceReview]', e.message); res.status(e.status || 500).json({message:e.status ? e.message : 'Unable to load workforce review.',...(e.attendanceConflicts ? {attendanceConflicts:e.attendanceConflicts} : {})});
} };
let schemaReady=false;
const schema = async () => {
 if(schemaReady)return;
 const {rows}=await pool.query("SELECT to_regclass('workforce_review_issues') IS NOT NULL AND to_regclass('workforce_deletion_audit') IS NOT NULL AS available");
 if(!rows[0]?.available)fail('Workforce review requires the workforce schema upgrade. Contact the deployment administrator.',503);
 schemaReady=true;
};
router.use(authenticate);
router.use(wrap(async (req,res,next) => {
 const user=(await pool.query('SELECT user_id,name,email,role,permissions,is_deleted FROM users WHERE user_id=$1',[req.user.user_id || req.user.id || req.user.userId])).rows[0];
 let p=user?.permissions; if(typeof p==='string') p=JSON.parse(p);
 if(!user || user.is_deleted || !['admin','super_admin','superadmin'].includes(user.role) || p?.is_active===false) return res.status(403).json({message:'Active admin account required.'});
 const owners=[process.env.SUPER_ADMIN_EMAIL || 'mtadmin@apricitydigital.in',process.env.SUPER_ADMIN_DB_EMAIL || 'admin@gmail.com'];
  req.reviewOwner=['super_admin','superadmin'].includes(user.role) || p?.role_type==='super_admin' || owners.some(e=>e.trim().toLowerCase()===String(user.email).trim().toLowerCase());
  req.reviewCanMerge=req.reviewOwner || [HR_MERGE_ADMIN_EMAIL,HR_HARD_DELETE_ADMIN_EMAIL].includes(String(user.email || '').trim().toLowerCase());
 req.reviewCanHardDelete=req.reviewOwner || String(user.email || '').trim().toLowerCase()===HR_HARD_DELETE_ADMIN_EMAIL;
 req.reviewCanManageNonDuplicates=req.reviewCanHardDelete;
 req.reviewActor=user; req.user={...req.user,user_id:user.user_id,role:'admin',permissions:p};
 next();
}));
router.use(attachCityScope);
const permission = action => (req,res,next) => {
 req.reviewAction=action;
 return req.reviewOwner ? next() : authorize('dashboard',action)(req,res,next);
};
async function filters(req) {
 let cities=req.reviewOwner ? null : getPermissionCityFilter(req,'dashboard',req.reviewAction);
 const city=req.body?.city_id ?? req.query.city_id;
 if(city && city!=='ALL') {
   if(!/^\d+$/.test(String(city))) fail('Invalid city.');
   cities=cities===null || cities.includes(Number(city)) ? [Number(city)] : [];
 }
 let sites=null;
 const supervisor=req.body?.user_id || req.query.user_id;
 if(supervisor) {
   if(!/^\d+$/.test(String(supervisor))) fail('Invalid supervisor.');
   sites=(await fetchUserKothiAccess(Number(supervisor),{allowZoneFallback:true,allowCityFallback:false})).ids || [];
 }
 const selectedSites=req.body?.kothiIds || (req.query.kothiIds ? String(req.query.kothiIds).split(',').map(Number) : null);
 if(selectedSites) {
   if(!Array.isArray(selectedSites) || !selectedSites.every(Number.isInteger)) fail('Invalid site selection.');
   sites=sites===null ? selectedSites : sites.filter(id=>selectedSites.includes(id));
 }
 const selectedId=(value,label)=>{
  if(value===undefined||value===null||value===''||value==='ALL')return null;
  if(!/^\d+$/.test(String(value)))fail(`Invalid ${label}.`);
  return [Number(value)];
 };
 return [cities,sites,selectedId(req.body?.zone_id ?? req.query.zone_id,'zone'),selectedId(req.body?.ward_id ?? req.query.ward_id,'ward')];
}
async function locationFilters(req){
 const allowed=req.reviewOwner?null:getPermissionCityFilter(req,'dashboard','view');
 const params=allowed===null?[]:[allowed];
 const cityWhere=allowed===null?'':'WHERE city_id=ANY($1::int[])';
 const zoneWhere=allowed===null?'':'WHERE z.city_id=ANY($1::int[])';
 const [cities,zones,wards]=await Promise.all([
  pool.query(`SELECT city_id,city_name FROM cities ${cityWhere} ORDER BY city_name`,params),
  pool.query(`SELECT z.zone_id,to_jsonb(z)->>'zone_name' AS zone_name,z.city_id FROM zones z ${zoneWhere} ORDER BY to_jsonb(z)->>'zone_name'`,params),
  pool.query(`SELECT w.ward_id,w.ward_name,w.zone_id,z.city_id FROM wards w JOIN zones z ON z.zone_id=w.zone_id ${zoneWhere} ORDER BY w.ward_name`,params)
 ]);
 return {cities:cities.rows,zones:zones.rows,wards:wards.rows};
}
async function records(req, client=pool) {
 const [cities,sites,zones,wards]=await filters(req);
 const start=req.body?.startDate || req.query.startDate || new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
 const end=req.body?.endDate || req.query.endDate || start;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start>end) fail('Invalid date range.');
 return (await client.query(`${recordsSql}
 SELECT s.*, CASE WHEN s.kind='regular' THEN r.present ELSE p.present END AS punched_in,
 CASE WHEN s.kind='regular' THEN r.punched_out ELSE p.punched_out END AS punched_out,
 COALESCE(r.mid_shift,false) AS mid_shift,
 CASE WHEN COALESCE(CASE WHEN s.kind='regular' THEN r.present ELSE p.present END,false) THEN 'present'
 WHEN COALESCE(r.on_leave,false) OR COALESCE(l.on_leave,false) THEN 'onLeave' ELSE 'notMarked' END AS status
 FROM scoped s
 LEFT JOIN LATERAL (SELECT bool_or(a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL) AS present,
 bool_or(a.punch_out_time IS NOT NULL) AS punched_out,bool_or(a.mid_shift_punch_in_time IS NOT NULL) AS mid_shift,
 bool_or(a.leave_type IS NOT NULL) AS on_leave FROM attendance a
 WHERE a.emp_id=(CASE WHEN s.kind='regular' THEN s.id END)::integer AND a.date::date BETWEEN $3::date AND $4::date) r ON true
 LEFT JOIN LATERAL (SELECT bool_or(a.punch_in IS NOT NULL) AS present,bool_or(a.punch_out IS NOT NULL) AS punched_out
 FROM self_attendance_records a WHERE a.self_attendance_id=(CASE WHEN s.kind='self_attendance' THEN s.id END)::uuid AND a.date BETWEEN $3::date AND $4::date) p ON true
 LEFT JOIN LATERAL (SELECT bool_or(status='approved') AS on_leave FROM self_attendance_leave_requests
 WHERE self_attendance_id=(CASE WHEN s.kind='self_attendance' THEN s.id END)::uuid AND requested_date BETWEEN $3::date AND $4::date) l ON true
 ORDER BY s.name,s.kind,s.id`,[cities,sites,start,end,zones,wards])).rows.map(reviewIdentity);
}
async function employee(req,client=pool) {
 if(!['regular','self_attendance'].includes(req.params.kind)) fail('Invalid employee type.');
 const [cities,sites,zones,wards]=await filters(req);
 const row=(await client.query(`${recordsSql} SELECT * FROM scoped WHERE kind=$3 AND id=$4`,[cities,sites,req.params.kind,req.params.id,zones,wards])).rows[0];
 if(!row) fail('Employee not found or outside your access.',404);
 return reviewIdentity(row);
}
router.post('/summary',permission('view'),wrap(async(req,res)=>{
 const rows=await records(req);
 const regular=summarize(rows.filter(r=>r.kind==='regular'));
 const self_attendance=summarize(rows.filter(r=>r.kind==='self_attendance'));
 res.json({data:{...summarize(rows),breakdown:{regular,self_attendance},change:{}}});
}));
router.get('/',permission('view'),wrap(async(req,res)=>{
 await schema();
 const rows=await workforceBlockDetails(pool,await records(req));
 const issues=(await pool.query('SELECT * FROM workforce_review_issues ORDER BY updated_at DESC')).rows;
 const candidateRows=(!req.query.kind||req.query.kind==='all')?rows:await records({...req,query:{...req.query,kind:'all'}});
 const excluded=await exclusions(pool),index=reviewDuplicateCandidates(candidateRows);
 const duplicates=row=>index(row).filter(other=>!excluded.has(pairKey(row,other)));
 const q=String(req.query.search || '').trim().toLowerCase();
 const enriched=rows.map(r=>{
  const candidates=duplicates(r);
  const signals=[...new Set(candidates.flatMap(other=>other.kind!==r.kind?['Same Aadhaar across Regular and Self Attendance']:matchingSignals(r,other)))];
  return {...r,duplicate_count:candidates.length,issues:issues.filter(i=>i.employee_kind===r.kind && i.employee_id===r.id),
   signals:[...signals,!r.site_id && 'No site assignment',r.active==='false' && 'Inactive',r.deleted==='true' && 'Deleted/ghost record',r.is_attendance_blocked && 'Attendance blocked'].filter(Boolean)};
 });
 const filtered=enriched.filter(r=>(!q || [r.name,r.emp_code,r.mobile,r.id].some(v=>String(v||'').toLowerCase().includes(q))) &&
 (!req.query.kind || req.query.kind==='all' || r.kind===req.query.kind || (req.query.kind==='professional' && r.kind==='self_attendance')) &&
 (!req.query.status || req.query.status==='all' || (req.query.status==='faceRegistered' ? r.face_registered : req.query.status==='midShiftPunchIn' ? r.mid_shift : r.status===req.query.status)) &&
 (req.query.review==='duplicates' ? r.duplicate_count>0 : !req.query.review || req.query.review==='all' || (req.query.review==='signals' ? r.signals.length>0 : r.issues.some(i=>i.status===req.query.review))));
 const page=Math.max(1,parseInt(req.query.page,10)||1),limit=25;
 res.json({data:filtered.slice((page-1)*limit,page*limit),total:filtered.length,pages:Math.max(1,Math.ceil(filtered.length/limit)),filters:await locationFilters(req),canHardDelete:req.reviewCanHardDelete,canMerge:req.reviewCanMerge,canManageNonDuplicates:req.reviewCanManageNonDuplicates,
 canWrite:req.reviewOwner || !req.user.permissions || req.user.permissions.modules?.dashboard==='write'});
}));
router.post('/:kind/:id/issues',permission('write'),wrap(async(req,res)=>{
 const row=await employee(req); const reason=String(req.body.reason || '').trim();
 if(reason.length<3 || reason.length>1000) fail('Enter an issue description between 3 and 1000 characters.');
 await schema();
 const data=(await pool.query(`INSERT INTO workforce_review_issues(employee_kind,employee_id,employee_name,reason,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *`,[row.kind,row.id,row.name,reason,req.reviewActor.user_id])).rows[0];
 res.status(201).json({data});
}));
router.patch('/:kind/:id/issues/:issueId',permission('write'),wrap(async(req,res)=>{
 const row=await employee(req); if(!['todo','done','dismissed'].includes(req.body.status)) fail('Invalid review status.');
 await schema();
 const data=(await pool.query(`UPDATE workforce_review_issues SET status=$1,updated_by=$2,updated_at=NOW() WHERE id=$3 AND employee_kind=$4 AND employee_id=$5 RETURNING *`,[req.body.status,req.reviewActor.user_id,req.params.issueId,row.kind,row.id])).rows[0];
 if(!data) fail('Issue not found.',404); res.json({data});
}));
const nonDuplicateOnly=(req,res,next)=>req.reviewCanManageNonDuplicates ? next() : res.status(403).json({message:'Workforce non-duplicate review permission required.'});
const hardDeleteOnly=(req,res,next)=>req.reviewCanHardDelete ? next() : res.status(403).json({message:'Workforce hard delete permission required.'});
const mergeOnly=(req,res,next)=>req.reviewCanMerge ? next() : res.status(403).json({message:'Workforce merge permission required.'});
router.get('/:kind/:id/duplicates',permission('view'),wrap(async(req,res)=>{
 const row=await employee(req),rows=await records({...req,query:{...req.query,kind:'all'}});
 const excluded=await exclusions(pool);
 const candidates=reviewDuplicateCandidates(rows)(row).filter(other=>!excluded.has(pairKey(row,other)));
 const enriched=await require('../utils/workforceMergeDetails').mergeDetails(pool,[row,...candidates]);
 res.json({employee:enriched[0],candidates:enriched.slice(1).map(other=>({...other,match_signals:other.kind!==row.kind?['Same Aadhaar across Regular and Self Attendance']:matchingSignals(row,other)}))});
}));
router.post('/:kind/:id/non-duplicate',nonDuplicateOnly,wrap(async(req,res)=>{
 const target=await employee(req);
 const other=await employee({...req,params:{kind:req.body.otherKind,id:req.body.otherId}});
 if(target.kind===other.kind && target.id===other.id) fail('Choose a different employee.');
 const ready=(await pool.query("SELECT to_regclass('workforce_non_duplicate_pairs') AS ready")).rows[0]?.ready;
 if(!ready)fail('Run the workforce schema upgrade before marking non-duplicates.',503);
 await pool.query('INSERT INTO workforce_non_duplicate_pairs(pair_key,created_by) VALUES($1,$2) ON CONFLICT DO NOTHING',[pairKey(target,other),req.reviewActor.user_id]);
 res.json({message:'Marked as different people. Employee records are unchanged.'});
}));
router.post('/:kind/:id/keep-separate',mergeOnly,wrap(async(req,res)=>{
 const code=String(req.body.employeeCode||'').trim();
 if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/.test(code))fail('Enter an employee code of 1 to 50 letters, digits, dots, slashes, underscores or hyphens.');
 const client=await pool.connect();
 try{
  const hasRequests=(await client.query("SELECT to_regclass('self_punch_requests') IS NOT NULL AS ready")).rows[0]?.ready;
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  // Acquire every writer lock before the first transaction snapshot, so an
  // import or registration that committed while waiting cannot be missed.
  await client.query(`LOCK TABLE employee,self_attendance_employees${hasRequests?',self_punch_requests':''} IN SHARE ROW EXCLUSIVE MODE`);
  await crossAttendance.ready(client);
  const target=await employee(req,client),other=await employee({...req,params:{kind:req.body.otherKind,id:req.body.otherId}},client);
  if(target.kind===other.kind && target.id===other.id)fail('Choose two different accounts.');
  const changes=[];
  let requestId=null;
  if(hasRequests){
   if(target.kind==='self_attendance')requestId=(await client.query("SELECT COALESCE(to_jsonb(t)->>'request_id',id::text) AS request_id FROM self_attendance_employees t WHERE id::text=$1",[target.id])).rows[0]?.request_id;
   if((await client.query("SELECT 1 FROM self_punch_requests WHERE lower(trim(emp_code))=lower($1) AND status IN ('pending','approved') AND ($2::text IS NULL OR id::text<>$2) LIMIT 1",[code,requestId])).rows.length)
    fail('This employee code is already used by a registration request. Enter a different code.',409);
  }
  const existing=await client.query(`SELECT kind,id FROM (
   SELECT 'regular' AS kind,emp_id::text AS id,emp_code FROM employee
   UNION ALL SELECT 'self_attendance',id::text,emp_code FROM self_attendance_employees
   UNION ALL SELECT employee_kind,source_id,emp_code FROM workforce_employee_aliases
   UNION ALL SELECT employee_kind,source_id,emp_code FROM workforce_cross_attendance_aliases
  ) codes WHERE lower(trim(emp_code))=lower($1) AND NOT(kind=$2 AND id=$3) LIMIT 1`,[code,target.kind,target.id]);
  if(existing.rows.length)fail('This employee code is already used. Enter a different code.',409);
  const table=target.kind==='regular'?'employee':'self_attendance_employees',key=target.kind==='regular'?'emp_id':'id';
  await client.query(`UPDATE ${quote(table)} SET emp_code=$1 WHERE ${quote(key)}::text=$2`,[code,target.id]);
  if(requestId){
   const registration=(await client.query('SELECT emp_code FROM self_punch_requests WHERE id::text=$1',[requestId])).rows[0];
   if(registration){
    changes.push({kind:'registration',id:requestId,before:{emp_code:registration.emp_code},after:{emp_code:code}});
    await client.query('UPDATE self_punch_requests SET emp_code=$1 WHERE id::text=$2',[code,requestId]);
   }
  }
  // Approved self registrations can flag the employee-master mirror as self-only.
  // Once the user explicitly keeps two systems separate, regular must be usable.
  if(target.kind!==other.kind){
   const regular=target.kind==='regular'?target:other;
   const profile=(await client.query('SELECT to_jsonb(t) AS row FROM employee t WHERE emp_id::text=$1 FOR UPDATE',[regular.id])).rows[0]?.row;
   if(profile?.self_attendance_enabled===true){
    changes.push({kind:'regular',id:regular.id,before:{self_attendance_enabled:true},after:{self_attendance_enabled:false}});
    await client.query('UPDATE employee SET self_attendance_enabled=false WHERE emp_id::text=$1',[regular.id]);
   }
  }
  await client.query('INSERT INTO workforce_non_duplicate_pairs(pair_key,created_by) VALUES($1,$2) ON CONFLICT DO NOTHING',[pairKey(target,other),req.reviewActor.user_id]);
  await client.query(`INSERT INTO workforce_separation_audit(employee_kind,employee_id,other_kind,other_id,previous_code,new_code,actor_user_id,profile_changes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[target.kind,target.id,other.kind,other.id,target.emp_code,code,req.reviewActor.user_id,JSON.stringify(changes)]);
  await client.query('COMMIT');res.json({message:'Accounts kept separate with a unique employee code. Both attendance histories are unchanged.'});
 }catch(error){await client.query('ROLLBACK');if(['40001','40P01','23505'].includes(error.code))fail('Employee codes changed. Refresh and try again.',409);throw error;}finally{client.release();}
}));
async function prepareMerge(req,client) {
 if(req.body.sources!==undefined){
  const sources=req.body.sources;
  if(!Array.isArray(sources)||!sources.length||sources.length>20||sources.some(s=>!s||!['regular','self_attendance'].includes(s.kind)||typeof s.id!=='string')||new Set(sources.map(s=>s.kind+':'+s.id)).size!==sources.length||req.body.sourceIds!==undefined)fail('Select between 1 and 20 different source accounts.');
  const target=await employee(req,client),selected=[],excluded=await exclusions(client);
  for(const source of sources){
   if(source.kind===target.kind)fail('Use same-type merge for accounts already in the selected system.');
   const row=await employee({...req,params:source},client);
   if(!target.aadhaar_number || target.aadhaar_number!==row.aadhaar_number)fail('Transferring systems requires the same verified Aadhaar on both accounts.',409);
   if(target.city_id==null || target.site_id==null || String(target.city_id)!==String(row.city_id)||String(target.site_id)!==String(row.site_id))fail('Both accounts must have the same city and assigned site before transferring attendance.',409);
   if(excluded.has(pairKey(target,row)))fail('These accounts were marked as different people.',409);
   selected.push(row);
  }
  return crossAttendance.planTransfer(client,target,selected,req.body.attendanceResolutions);
 }
 const ids=req.body.sourceIds;
 if(!Array.isArray(ids) || !ids.length || ids.length>20 || !ids.every(id=>typeof id==='string' && id!==req.params.id) || new Set(ids).size!==ids.length) fail('Select between 1 and 20 different duplicate IDs.');
 const target=await employee(req,client);
 const excluded=await exclusions(client);
 const selected=[target];
 for(const id of ids) {
  const source=await employee({...req,params:{...req.params,id}},client);
  if(selected.some(other=>excluded.has(pairKey(other,source)))) fail('Selected employees were marked as different people. Refresh the duplicate review.',409);
  selected.push(source);
  if(!matchingSignals(target,source).length) fail('Each duplicate must match the main employee by Aadhaar, name or mobile.');
 }
 assertSameAadhaar(selected);
 return mergePlan(client,target.kind,target.id,[...ids].sort(),{weeklyOffSourceId:req.body.weeklyOffSourceId,attendanceResolutions:req.body.attendanceResolutions});
}
router.post('/:kind/:id/merge-preview',mergeOnly,wrap(async(req,res)=>{
 await schema();await ensureMergeSchema();const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  const plan=await prepareMerge(req,client);
  if(!plan.crossAttendance)await assertAliasTriggers(client,plan);
  await recovery.assertRecoveryReady(client,plan);
  await (plan.crossAttendance?crossAttendance.validateTransfer:validateMove)(client,plan);
  await client.query('ROLLBACK');
  res.json({targetId:plan.targetId,sourceIds:plan.sourceIds,crossAttendance:!!plan.crossAttendance,login:plan.login,attendance:plan.attendance?.summary,weeklyOff:plan.weeklyOff?{selectedId:plan.weeklyOff.selectedId,days:plan.weeklyOff.days}:null,restoreWindowHours:48,affected:plan.affected.map(({table,column,count})=>({table,column,count})),fingerprint:plan.fingerprint});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
router.post('/:kind/:id/merge',mergeOnly,wrap(async(req,res)=>{
 if(req.body.identityConfirmed!==true) fail('Confirm these accounts belong to the same person and the chosen main account has their working login and enrolled face.');
 const reason=String(req.body.reason || '').trim();
 if(reason.length<3 || reason.length>1000 || req.body.confirmation!==req.params.id || typeof req.body.fingerprint!=='string') fail('Enter a merge reason and confirm the main employee ID after previewing.');
 await schema();await ensureMergeSchema();const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-self-attendance-list'))");
  const plan=await prepareMerge(req,client);
  if(plan.fingerprint!==req.body.fingerprint) fail('Employee or attendance data changed. Preview this merge again.',409);
  if(!plan.crossAttendance)await assertAliasTriggers(client,plan);
  await recovery.assertRecoveryReady(client,plan);await (plan.crossAttendance?crossAttendance.validateTransfer:validateMove)(client,plan);
  const audit=await recovery.beginRecovery(client,plan,req.reviewActor.user_id,reason);
  if(plan.crossAttendance){
   await crossAttendance.applyTransfer(client,plan,audit);
   await client.query('COMMIT');
   return res.json({message:'Accounts merged into the selected attendance system. All original attendance and linked evidence are permanently preserved. Recovery is available for 48 hours.',targetId:plan.targetId,mergeId:audit.id,restoreUntil:audit.restore_until});
  }
  await moveReferences(client,plan);
  await retainMergedLogins(client,plan);
  const key=plan.kind==='regular'?'emp_id':'id',table=plan.kind==='regular'?'employee':'self_attendance_employees';
  for(const source of plan.profiles.filter(row=>String(row[key])!==plan.targetId)) {
   const id=String(source[key]);
   const authEnabled=source.is_active!==false;
   await client.query('UPDATE workforce_employee_aliases SET target_id=$1,auth_enabled=auth_enabled AND $4 WHERE employee_kind=$2 AND target_id=$3',[plan.targetId,plan.kind,id,authEnabled]);
   await client.query('INSERT INTO workforce_employee_aliases(employee_kind,source_id,target_id,emp_code,face_id,auth_enabled) VALUES($1,$2,$3,$4,$5,$6)',[plan.kind,id,plan.targetId,source.emp_code || null,source.face_id || null,authEnabled]);
  }
  await client.query(`DELETE FROM ${quote(table)} WHERE ${quote(key)}::text=ANY($1::text[])`,[plan.sourceIds]);
  await client.query('COMMIT');res.json({message:'Duplicate IDs merged. You can preview and revert this merge within 48 hours from Merge history.',targetId:plan.targetId,mergeId:audit.id,restoreUntil:audit.restore_until});
 }catch(error){await client.query('ROLLBACK');if(['40001','40P01','23505','23503'].includes(error.code)) fail('Records changed or conflicting settings were found. No merge was saved. Refresh and preview again.',409);throw error;}finally{client.release();}
}));
router.get('/merges',mergeOnly,wrap(async(req,res)=>{
 await recovery.ensureRecoverySchema(pool);
 const page=Math.max(1,parseInt(req.query.page,10)||1);
 const owner=req.reviewOwner;
 const actorClause=owner?'':'WHERE actor_user_id=$1';
 const pageParam=owner?1:2;
 const offset=(page-1)*25;
 const params=owner?[offset]:[req.reviewActor.user_id,offset];
 const {rows}=await pool.query(`SELECT id,employee_kind,target_id,source_ids,reason,created_at,restore_until,reverted_at,
 COALESCE(profile_snapshots->0->>'full_name',profile_snapshots->0->>'name','Employee') AS employee_name,
 (recovery_version=1 AND reverted_at IS NULL AND restore_until>clock_timestamp()) AS can_revert
 FROM workforce_merge_audit ${actorClause} ORDER BY id DESC LIMIT 25 OFFSET $${pageParam}`,params);
 const count=(await pool.query(`SELECT count(*)::int AS total FROM workforce_merge_audit ${actorClause}`,owner?[]:[req.reviewActor.user_id])).rows[0].total;
 res.json({data:rows,total:count,pages:Math.max(1,Math.ceil(count/25))});
}));
router.get('/merges/:mergeId/attendance-originals',mergeOnly,wrap(async(req,res)=>{
 if(!/^\d+$/.test(String(req.params.mergeId)))fail('Invalid merge reference.');
 await crossAttendance.ready(pool);
 const audit=(await pool.query('SELECT * FROM workforce_merge_audit WHERE id=$1',[req.params.mergeId])).rows[0];
 if(!audit)fail('Merge not found.',404);
 if(!req.reviewOwner && Number(audit.actor_user_id)!==Number(req.reviewActor.user_id))fail('You can only view original attendance for your own merges.',403);
 // Current geographic access is required even for an old merge performed by HR.
 await employee({...req,params:{kind:audit.employee_kind,id:audit.target_id}});
 const archived=(await pool.query(`SELECT employee_kind,employee_id,source_table,original_rows FROM workforce_transfer_archive
 WHERE merge_id=$1 AND source_table IN ('attendance','self_attendance_records','self_attendance_leave_requests') ORDER BY id`,[audit.id])).rows;
 const data=archived.flatMap(item=>item.original_rows.map(row=>({kind:item.employee_kind,employeeId:item.employee_id,date:row.date||row.requested_date,
  punchIn:row.punch_in||row.punch_in_time||null,punchOut:row.punch_out||row.punch_out_time||null,leaveType:row.leave_type||null,
  approvalStatus:row.punch_approval_status||row.status||null,midShiftPunchIn:row.mid_shift_punch_in_time||null})));
 res.json({data});
}));
router.post('/merges/:mergeId/revert-preview',mergeOnly,wrap(async(req,res)=>{
 const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-self-attendance-list'))");
  const audit=await recovery.auditForRestore(client,req.params.mergeId);
   if(!req.reviewOwner && Number(audit.actor_user_id)!==Number(req.reviewActor.user_id)) fail('You can only preview a revert for a merge you performed.',403);
  const preview=await recovery.previewRestore(client,audit);
  await client.query('ROLLBACK');
  res.json({mergeId:audit.id,targetId:audit.target_id,sourceIds:audit.source_ids,restoreUntil:audit.restore_until,...preview});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
router.post('/merges/:mergeId/revert',mergeOnly,wrap(async(req,res)=>{
 const reason=String(req.body.reason || '').trim();
 if(reason.length<3 || reason.length>1000 || typeof req.body.fingerprint!=='string')fail('Preview the revert and enter a reason between 3 and 1000 characters.');
 const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-self-attendance-list'))");
  const audit=await recovery.auditForRestore(client,req.params.mergeId);
   if(!req.reviewOwner && Number(audit.actor_user_id)!==Number(req.reviewActor.user_id)) fail('You can only revert a merge you performed.',403);
  if(req.body.confirmation!==audit.target_id)fail('Type the main employee ID to confirm reverting this merge.');
  const preview=await recovery.previewRestore(client,audit);
  if(preview.fingerprint!==req.body.fingerprint)fail('Employee data changed. Preview the revert again.',409);
  // PostgreSQL time is checked again after potentially expensive replay checks.
  await recovery.auditForRestore(client,req.params.mergeId);
  await recovery.replayUndo(client,audit);
  await recovery.auditForRestore(client,req.params.mergeId);
  await client.query(`UPDATE workforce_merge_audit SET reverted_at=clock_timestamp(),reverted_by=$2,revert_reason=$3 WHERE id=$1`,[audit.id,req.reviewActor.user_id,reason]);
  await client.query('COMMIT');
  res.json({message:'Merge reverted. Original employee profiles and record ownership restored; unrelated newer records preserved.'});
 }catch(error){await client.query('ROLLBACK');if(['40001','40P01','23505','23503','23514'].includes(error.code))fail('Newer changes or dependent settings conflict with this revert. No records were restored. Refresh and preview again.',409);throw error;}finally{client.release();}
}));
router.get('/:kind/:id/delete-preview',hardDeleteOnly,wrap(async(req,res)=>{
 const row=await employee(req); const client=await pool.connect();
 try {
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const plan=await deletionPlan(client,row.kind,row.id); await client.query('COMMIT');
 res.json({employee:row,affected:plan.map(({table,count})=>({table,count})),fingerprint:fingerprint(plan)});
 } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}));
router.delete('/:kind/:id',hardDeleteOnly,wrap(async(req,res)=>{
 const reason=String(req.body.reason || '').trim();
 if(reason.length<3 || reason.length>1000 || req.body.confirmation!==req.params.id) fail('Enter a reason and the exact employee ID to confirm deletion.');
 await schema(); await ensureMergeSchema(); const client=await pool.connect();
 try {
 await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-self-attendance-list'))");
 const row=await employee(req,client);
 if((await client.query('SELECT 1 FROM workforce_employee_aliases WHERE employee_kind=$1 AND target_id=$2 LIMIT 1',[row.kind,row.id])).rows.length) fail('This main employee has merged IDs. Hard deletion is blocked to preserve their attendance and login links.',409);
 if((await client.query("SELECT to_regclass('workforce_cross_attendance_aliases') IS NOT NULL AS ready")).rows[0]?.ready && (await client.query('SELECT 1 FROM workforce_cross_attendance_aliases WHERE target_kind=$1 AND target_id=$2 LIMIT 1',[row.kind,row.id])).rows.length)fail('This main account has transferred attendance. Hard deletion is blocked to preserve its history.',409);
 const table=row.kind==='regular'?'employee':'self_attendance_employees',key=row.kind==='regular'?'emp_id':'id';
 await client.query(`SELECT ${quote(key)} FROM ${quote(table)} WHERE ${quote(key)}::text=$1 FOR UPDATE`,[row.id]);
 const plan=await deletionPlan(client,row.kind,row.id);
 if(req.body.fingerprint!==fingerprint(plan)) fail('Related records changed. Preview this deletion again.',409);
 for(const item of plan) await client.query(`DELETE FROM ${quote(item.table)} WHERE ${item.predicate}`,[row.id]);
 await client.query(`INSERT INTO workforce_deletion_audit(employee_kind,employee_id,employee_name,reason,actor_user_id,affected_rows) VALUES($1,$2,$3,$4,$5,$6)`,[row.kind,row.id,row.name,reason,req.reviewActor.user_id,JSON.stringify(plan.map(({table,count})=>({table,count})))]);
 await client.query('COMMIT');res.json({message:'Employee and previewed dependent records permanently deleted. Audit retained.'});
 } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}));
module.exports=router;
