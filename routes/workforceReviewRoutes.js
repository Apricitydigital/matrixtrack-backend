const {reviewIdentity,assertSameAadhaar}=require('../utils/workforceAadhaar');
const {pairKey,exclusions}=require('../utils/workforceNonDuplicates');
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
const recovery=require('../utils/workforceMergeRecovery');
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
 ORDER BY s.name,s.kind,s.id`,[...params,start,end])).rows.map(reviewIdentity);
}
async function employee(req,client=pool) {
 if(!['regular','professional'].includes(req.params.kind)) fail('Invalid employee type.');
 const params=await filters(req);
 const row=(await client.query(`${recordsSql} SELECT * FROM scoped WHERE kind=$3 AND id=$4`,[...params,req.params.kind,req.params.id])).rows[0];
 if(!row) fail('Employee not found or outside your access.',404);
 return reviewIdentity(row);
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
 const excluded=await exclusions(pool),index=duplicateIndex(rows);
 const duplicates=row=>index(row).filter(other=>!excluded.has(pairKey(row,other)));
 const q=String(req.query.search || '').trim().toLowerCase();
 const names=new Map(),mobiles=new Map(),codes=new Map();
 for(const r of rows) for(const [map,key] of [[names,r.name?.trim().toLowerCase()],[mobiles,r.mobile?.replace(/\D/g,'')],[codes,r.emp_code?.trim().toLowerCase()]]) if(key) map.set(key,(map.get(key)||0)+1);
 const enriched=rows.map(r=>({...r,duplicate_count:duplicates(r).length,issues:issues.filter(i=>i.employee_kind===r.kind && i.employee_id===r.id),
 signals:[duplicates(r).some(other=>matchingSignals(r,other).includes('Same Aadhaar')) && 'Same Aadhaar',names.get(r.name?.trim().toLowerCase())>1 && 'Same name',mobiles.get(r.mobile?.replace(/\D/g,''))>1 && 'Same mobile',codes.get(r.emp_code?.trim().toLowerCase())>1 && 'Same employee code',!r.site_id && 'No site assignment',r.active==='false' && 'Inactive',r.deleted==='true' && 'Deleted/ghost record'].filter(Boolean)}));
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
const ownerOnly=(req,res,next)=>req.reviewOwner ? next() : res.status(403).json({message:'Only a superadmin can merge employees, revert merges or permanently delete employee records.'});
router.get('/:kind/:id/duplicates',permission('view'),wrap(async(req,res)=>{
 const row=await employee(req),rows=await records(req);
 const excluded=await exclusions(pool);
 const enriched=await require('../utils/workforceMergeDetails').mergeDetails(pool,[row,...duplicateIndex(rows)(row).filter(other=>!excluded.has(pairKey(row,other)))]);
 res.json({employee:enriched[0],candidates:enriched.slice(1).map(other=>({...other,match_signals:matchingSignals(row,other)}))});
}));
router.post('/:kind/:id/non-duplicate',ownerOnly,wrap(async(req,res)=>{
 const target=await employee(req);
 const other=await employee({...req,params:{kind:req.body.otherKind,id:req.body.otherId}});
 if(target.kind===other.kind && target.id===other.id) fail('Choose a different employee.');
 const ready=(await pool.query("SELECT to_regclass('workforce_non_duplicate_pairs') AS ready")).rows[0]?.ready;
 if(!ready)fail('Run the workforce schema upgrade before marking non-duplicates.',503);
 await pool.query('INSERT INTO workforce_non_duplicate_pairs(pair_key,created_by) VALUES($1,$2) ON CONFLICT DO NOTHING',[pairKey(target,other),req.reviewActor.user_id]);
 res.json({message:'Marked as different people. Employee records are unchanged.'});
}));
async function prepareMerge(req,client) {
 const ids=req.body.sourceIds;
 if(!Array.isArray(ids) || !ids.length || ids.length>20 || !ids.every(id=>typeof id==='string' && id!==req.params.id) || new Set(ids).size!==ids.length) fail('Select between 1 and 20 different duplicate IDs.');
 const target=await employee(req,client);
 const excluded=await exclusions(client);
 const selected=[target];
 for(const id of ids) {
  const source=await employee({...req,params:{...req.params,id}},client);
  if(selected.some(other=>excluded.has(pairKey(other,source)))) fail('Selected employees were marked as different people. Refresh the duplicate review.',409);
  selected.push(source);
  if(!matchingSignals(target,source).length) fail('Each duplicate must match the main employee by Aadhaar, name, mobile or code.');
 }
 assertSameAadhaar(selected);
 return mergePlan(client,target.kind,target.id,[...ids].sort(),{weeklyOffSourceId:req.body.weeklyOffSourceId});
}
router.post('/:kind/:id/merge-preview',ownerOnly,wrap(async(req,res)=>{
 await schema();await ensureMergeSchema();const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  const plan=await prepareMerge(req,client);await assertAliasTriggers(client,plan);await recovery.assertRecoveryReady(client,plan);await validateMove(client,plan);
  await client.query('ROLLBACK');
  res.json({targetId:plan.targetId,sourceIds:plan.sourceIds,login:plan.login,attendance:plan.attendance?.summary,weeklyOff:plan.weeklyOff?{selectedId:plan.weeklyOff.selectedId,days:plan.weeklyOff.days}:null,restoreWindowHours:48,affected:plan.affected.map(({table,column,count})=>({table,column,count})),fingerprint:plan.fingerprint});
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
  await assertAliasTriggers(client,plan);await recovery.assertRecoveryReady(client,plan);await validateMove(client,plan);
  const audit=await recovery.beginRecovery(client,plan,req.reviewActor.user_id,reason);
  await moveReferences(client,plan);
  await retainMergedLogins(client,plan);
  const key=plan.kind==='regular'?'emp_id':'id',table=plan.kind==='regular'?'employee':'professional_employees';
  for(const source of plan.profiles.filter(row=>String(row[key])!==plan.targetId)) {
   const id=String(source[key]);
   await client.query('UPDATE workforce_employee_aliases SET target_id=$1 WHERE employee_kind=$2 AND target_id=$3',[plan.targetId,plan.kind,id]);
   await client.query('INSERT INTO workforce_employee_aliases(employee_kind,source_id,target_id,emp_code,face_id) VALUES($1,$2,$3,$4,$5)',[plan.kind,id,plan.targetId,source.emp_code || null,source.face_id || null]);
  }
  await client.query(`DELETE FROM ${quote(table)} WHERE ${quote(key)}::text=ANY($1::text[])`,[plan.sourceIds]);
  await client.query('COMMIT');res.json({message:'Duplicate IDs merged. You can preview and revert this merge within 48 hours from Merge history.',targetId:plan.targetId,mergeId:audit.id,restoreUntil:audit.restore_until});
 }catch(error){await client.query('ROLLBACK');if(['40001','40P01','23505','23503'].includes(error.code)) fail('Records changed or conflicting settings were found. No merge was saved. Refresh and preview again.',409);throw error;}finally{client.release();}
}));
router.get('/merges',ownerOnly,wrap(async(req,res)=>{
 await recovery.ensureRecoverySchema(pool);
 const page=Math.max(1,parseInt(req.query.page,10)||1);
 const {rows}=await pool.query(`SELECT id,employee_kind,target_id,source_ids,reason,created_at,restore_until,reverted_at,
 COALESCE(profile_snapshots->0->>'full_name',profile_snapshots->0->>'name','Employee') AS employee_name,
 (recovery_version=1 AND reverted_at IS NULL AND restore_until>clock_timestamp()) AS can_revert
 FROM workforce_merge_audit ORDER BY id DESC LIMIT 25 OFFSET $1`,[(page-1)*25]);
 const count=(await pool.query('SELECT count(*)::int AS total FROM workforce_merge_audit')).rows[0].total;
 res.json({data:rows,total:count,pages:Math.max(1,Math.ceil(count/25))});
}));
router.post('/merges/:mergeId/revert-preview',ownerOnly,wrap(async(req,res)=>{
 const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))");
  const audit=await recovery.auditForRestore(client,req.params.mergeId);
  const preview=await recovery.previewRestore(client,audit);
  await client.query('ROLLBACK');
  res.json({mergeId:audit.id,targetId:audit.target_id,sourceIds:audit.source_ids,restoreUntil:audit.restore_until,...preview});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));
router.post('/merges/:mergeId/revert',ownerOnly,wrap(async(req,res)=>{
 const reason=String(req.body.reason || '').trim();
 if(reason.length<3 || reason.length>1000 || typeof req.body.fingerprint!=='string')fail('Preview the revert and enter a reason between 3 and 1000 characters.');
 const client=await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))");
  const audit=await recovery.auditForRestore(client,req.params.mergeId);
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
