const router = require('express').Router();
const pool = require('../config/db');
const authenticate = require('../middleware/authMiddleware');
const { attachCityScope } = require('../middleware/cityScope');
const { authorize, getPermissionCityFilter } = require('../middleware/permissionMiddleware');
const { fetchUserKothiAccess } = require('../utils/userKothiAccess');
const { recordsSql, summarize, deletionPlan, fingerprint, quote } = require('../utils/workforceReview');
const {duplicateIndex,matchingSignals,mergePlan,moveReferences,validateMove,assertAliasTriggers}=require('../utils/workforceMerge');
const {ensureMergeSchema}=require('../utils/employeeAliases');
const {retainMergedLogins}=require('../utils/professionalMergeLogin');
const fail = (message, status=400) => { throw Object.assign(new Error(message), { status }); };
const wrap = fn => async (req,res,next) => { try { await fn(req,res,next); } catch(e) {
 console.error('[WorkforceReview]', e.message); res.status(e.status || 500).json({message:e.status ? e.message : 'Unable to load workforce review.'});
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
 return [cities,sites];
}
async function records(req, client=pool) {
 const params=await filters(req);
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
 FROM professional_attendance a WHERE a.professional_id=(CASE WHEN s.kind='professional' THEN s.id END)::uuid AND a.date BETWEEN $3::date AND $4::date) p ON true
 LEFT JOIN LATERAL (SELECT bool_or(status='approved') AS on_leave FROM professional_leave_requests
 WHERE professional_id=(CASE WHEN s.kind='professional' THEN s.id END)::uuid AND requested_date BETWEEN $3::date AND $4::date) l ON true
 ORDER BY s.name,s.kind,s.id`,[...params,start,end])).rows;
}
async function employee(req,client=pool) {
 if(!['regular','professional'].includes(req.params.kind)) fail('Invalid employee type.');
 const params=await filters(req);
 const row=(await client.query(`${recordsSql} SELECT * FROM scoped WHERE kind=$3 AND id=$4`,[...params,req.params.kind,req.params.id])).rows[0];
 if(!row) fail('Employee not found or outside your access.',404);
 return row;
}
router.post('/summary',permission('view'),wrap(async(req,res)=>{
 const rows=await records(req);
 const regular=summarize(rows.filter(r=>r.kind==='regular'));
 const professional=summarize(rows.filter(r=>r.kind==='professional'));
 res.json({data:{...summarize(rows),breakdown:{regular,professional},change:{}}});
}));
router.get('/',permission('view'),wrap(async(req,res)=>{
 await schema();
 const rows=await records(req);
 const issues=(await pool.query('SELECT * FROM workforce_review_issues ORDER BY updated_at DESC')).rows;
 const duplicates=duplicateIndex(rows);
 const q=String(req.query.search || '').trim().toLowerCase();
 const names=new Map(),mobiles=new Map(),codes=new Map();
 for(const r of rows) for(const [map,key] of [[names,r.name?.trim().toLowerCase()],[mobiles,r.mobile?.replace(/\D/g,'')],[codes,r.emp_code?.trim().toLowerCase()]]) if(key) map.set(key,(map.get(key)||0)+1);
 const enriched=rows.map(r=>({...r,duplicate_count:duplicates(r).length,issues:issues.filter(i=>i.employee_kind===r.kind && i.employee_id===r.id),
 signals:[names.get(r.name?.trim().toLowerCase())>1 && 'Same name',mobiles.get(r.mobile?.replace(/\D/g,''))>1 && 'Same mobile',codes.get(r.emp_code?.trim().toLowerCase())>1 && 'Same employee code',!r.site_id && 'No site assignment',r.active==='false' && 'Inactive',r.deleted==='true' && 'Deleted/ghost record'].filter(Boolean)}));
 const filtered=enriched.filter(r=>(!q || [r.name,r.emp_code,r.mobile,r.id].some(v=>String(v||'').toLowerCase().includes(q))) &&
 (!req.query.kind || req.query.kind==='all' || r.kind===req.query.kind) &&
 (!req.query.status || req.query.status==='all' || (req.query.status==='faceRegistered' ? r.face_registered : req.query.status==='midShiftPunchIn' ? r.mid_shift : r.status===req.query.status)) &&
 (!req.query.review || req.query.review==='all' || (req.query.review==='signals' ? r.signals.length>0 : r.issues.some(i=>i.status===req.query.review))));
 const page=Math.max(1,parseInt(req.query.page,10)||1),limit=25;
 res.json({data:filtered.slice((page-1)*limit,page*limit),total:filtered.length,pages:Math.max(1,Math.ceil(filtered.length/limit)),canHardDelete:req.reviewOwner,canMerge:req.reviewOwner,
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
const ownerOnly=(req,res,next)=>req.reviewOwner ? next() : res.status(403).json({message:'Only a superadmin can permanently delete employee records.'});
router.get('/:kind/:id/duplicates',permission('view'),wrap(async(req,res)=>{
 const row=await employee(req),rows=await records(req);
 res.json({employee:row,candidates:duplicateIndex(rows)(row).map(other=>({...other,match_signals:matchingSignals(row,other)}))});
}));
async function prepareMerge(req,client) {
 const ids=req.body.sourceIds;
 if(!Array.isArray(ids) || !ids.length || ids.length>20 || !ids.every(id=>typeof id==='string' && id!==req.params.id) || new Set(ids).size!==ids.length) fail('Select between 1 and 20 different duplicate IDs.');
 const target=await employee(req,client);
 for(const id of ids) {
  const source=await employee({...req,params:{...req.params,id}},client);
  if(!matchingSignals(target,source).length) fail('Each duplicate must match the main employee by name, mobile or code.');
 }
 return mergePlan(client,target.kind,target.id,[...ids].sort());
}
router.post('/:kind/:id/merge-preview',ownerOnly,wrap(async(req,res)=>{
 await schema();await ensureMergeSchema();const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  const plan=await prepareMerge(req,client);await assertAliasTriggers(client,plan);await validateMove(client,plan);
  await client.query('ROLLBACK');
  res.json({targetId:plan.targetId,sourceIds:plan.sourceIds,login:plan.login,attendance:plan.attendance?.summary,affected:plan.affected.map(({table,column,count})=>({table,column,count})),fingerprint:plan.fingerprint});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
router.post('/:kind/:id/merge',ownerOnly,wrap(async(req,res)=>{
 if(req.body.identityConfirmed!==true) fail('Confirm these accounts belong to the same person and the chosen main account has their working login and enrolled face.');
 const reason=String(req.body.reason || '').trim();
 if(reason.length<3 || reason.length>1000 || req.body.confirmation!==req.params.id || typeof req.body.fingerprint!=='string') fail('Enter a merge reason and confirm the main employee ID after previewing.');
 await schema();await ensureMergeSchema();const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))");
  const plan=await prepareMerge(req,client);
  if(plan.fingerprint!==req.body.fingerprint) fail('Employee or attendance data changed. Preview this merge again.',409);
  await assertAliasTriggers(client,plan);await validateMove(client,plan);await moveReferences(client,plan);
  await retainMergedLogins(client,plan);
  const key=plan.kind==='regular'?'emp_id':'id',table=plan.kind==='regular'?'employee':'professional_employees';
  for(const source of plan.profiles.filter(row=>String(row[key])!==plan.targetId)) {
   const id=String(source[key]);
   await client.query('UPDATE workforce_employee_aliases SET target_id=$1 WHERE employee_kind=$2 AND target_id=$3',[plan.targetId,plan.kind,id]);
   await client.query('INSERT INTO workforce_employee_aliases(employee_kind,source_id,target_id,emp_code,face_id) VALUES($1,$2,$3,$4,$5)',[plan.kind,id,plan.targetId,source.emp_code || null,source.face_id || null]);
  }
  await client.query(`INSERT INTO workforce_merge_audit(employee_kind,target_id,source_ids,actor_user_id,reason,profile_snapshots,affected_rows,attendance_snapshots) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[plan.kind,plan.targetId,plan.sourceIds,req.reviewActor.user_id,reason,JSON.stringify(plan.profiles),JSON.stringify(plan.affected),JSON.stringify(plan.attendance?.groups.flatMap(group=>group.originals) || [])]);
  await client.query(`DELETE FROM ${quote(table)} WHERE ${quote(key)}::text=ANY($1::text[])`,[plan.sourceIds]);
  await client.query('COMMIT');res.json({message:'Duplicate IDs merged. Attendance and dependent records retained; old IDs redirect to the main employee.',targetId:plan.targetId});
 }catch(error){await client.query('ROLLBACK');if(['40001','40P01','23505','23503'].includes(error.code)) fail('Records changed or conflicting settings were found. No merge was saved. Refresh and preview again.',409);throw error;}finally{client.release();}
}));
router.get('/:kind/:id/delete-preview',ownerOnly,wrap(async(req,res)=>{
 const row=await employee(req); const client=await pool.connect();
 try {
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const plan=await deletionPlan(client,row.kind,row.id); await client.query('COMMIT');
 res.json({employee:row,affected:plan.map(({table,count})=>({table,count})),fingerprint:fingerprint(plan)});
 } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}));
router.delete('/:kind/:id',ownerOnly,wrap(async(req,res)=>{
 const reason=String(req.body.reason || '').trim();
 if(reason.length<3 || reason.length>1000 || req.body.confirmation!==req.params.id) fail('Enter a reason and the exact employee ID to confirm deletion.');
 await schema(); await ensureMergeSchema(); const client=await pool.connect();
 try {
 await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))");
 const row=await employee(req,client);
 if((await client.query('SELECT 1 FROM workforce_employee_aliases WHERE employee_kind=$1 AND target_id=$2 LIMIT 1',[row.kind,row.id])).rows.length) fail('This main employee has merged IDs. Hard deletion is blocked to preserve their attendance and login links.',409);
 const table=row.kind==='regular'?'employee':'professional_employees',key=row.kind==='regular'?'emp_id':'id';
 await client.query(`SELECT ${quote(key)} FROM ${quote(table)} WHERE ${quote(key)}::text=$1 FOR UPDATE`,[row.id]);
 const plan=await deletionPlan(client,row.kind,row.id);
 if(req.body.fingerprint!==fingerprint(plan)) fail('Related records changed. Preview this deletion again.',409);
 for(const item of plan) await client.query(`DELETE FROM ${quote(item.table)} WHERE ${item.predicate}`,[row.id]);
 await client.query(`INSERT INTO workforce_deletion_audit(employee_kind,employee_id,employee_name,reason,actor_user_id,affected_rows) VALUES($1,$2,$3,$4,$5,$6)`,[row.kind,row.id,row.name,reason,req.reviewActor.user_id,JSON.stringify(plan.map(({table,count})=>({table,count})))]);
 await client.query('COMMIT');res.json({message:'Employee and previewed dependent records permanently deleted. Audit retained.'});
 } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}));
module.exports=router;
