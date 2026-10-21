const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
let ready;
function markPunchCutoffSchemaReady(){ready=Promise.resolve();}
function ensurePunchCutoffSchema() {
  if (!ready) ready = (async () => {
    const client = await pool.connect();
    let schemaError;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
      await client.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_hod.sql'),'utf8'));
      await client.query("SELECT pg_advisory_xact_lock(hashtext('professional-punch-cutoff-schema'))");
      await client.query(fs.readFileSync(path.join(__dirname, '../db/migrations/20261014_professional_punch_cutoff.sql'), 'utf8'));
      await client.query(fs.readFileSync(path.join(__dirname, '../db/migrations/20261014_professional_punch_cutoff_bulk.sql'), 'utf8'));
      await client.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_hod_punch_approval.sql'),'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      schemaError=error;
      if(error.message!=='Query read timeout')try{await client.query('ROLLBACK');}catch(rollbackError){console.error('[PunchCutoff Schema] Rollback failed:',rollbackError.message);}
      throw error;
    }
    finally { client.release(schemaError); }
  })().catch(error => { ready = null; throw error; });
  return ready;
}
const PM_ROLES = ['Project Manager', 'Project Head / Site Head'];
async function capabilities(client, id) {
  const { rows } = await client.query(`SELECT d.designation_name FROM professional_designation_assignments a
    JOIN designation d ON d.designation_id=a.designation_id WHERE a.professional_id=$1`, [id]);
  const roles = rows.map(r => r.designation_name);
  const pm = roles.some(r => PM_ROLES.includes(r));
  const ho = roles.includes('HO Coordinator');
  const hod = roles.includes('Head of Department');
  return { pm, ho, hod, can_manage: pm || ho, can_view: pm || ho || roles.includes('Head of Department') };
}
function nextDecision(status, caps, decision, actorId, employeeId, pmActor) {
  const fail = message => { throw Object.assign(new Error(message), { status: 403 }); };
  if (!['allow', 'reject'].includes(decision)) throw Object.assign(new Error('Choose allow or reject.'), { status: 400 });
  if (actorId === employeeId) fail('You cannot review your own punch-in.');
  if (status === 'pending_hod' && caps.hod) return decision === 'reject' ? 'rejected' : 'accepted';
  if (status === 'pending_pm' && caps.pm) return decision === 'reject' ? 'rejected' : 'pending_ho';
  if (status === 'pending_ho' && caps.ho) {
    if (actorId === pmActor) fail('HO approval must be by a different reviewer.');
    return decision === 'reject' ? 'rejected' : 'accepted';
  }
  fail('Request is no longer pending at your approval stage.');
}
async function notifyStage(client, employeeId, date, stage) {
  const roles = stage === 'pending_hod' ? ['Head of Department'] : stage === 'pending_pm' ? PM_ROLES : ['HO Coordinator'];
  await client.query(`INSERT INTO professional_notifications(professional_id,type,title,message,metadata)
    SELECT DISTINCT a.professional_id,'late-punch-request','Late punch-in approval',p.full_name || ' has a late punch-in awaiting your review.',
      jsonb_build_object('category','late-punch','employee_id',p.id,'date',$2::text,'stage',$3::text)
    FROM professional_employees p JOIN professional_site_access s ON s.kothi_id=p.kothi_id
    JOIN professional_designation_assignments a ON a.professional_id=s.professional_id
    JOIN designation d ON d.designation_id=a.designation_id
    JOIN professional_employees reviewer ON reviewer.id=a.professional_id AND reviewer.is_active=TRUE
    WHERE p.id=$1 AND a.professional_id<>p.id AND d.designation_name=ANY($4::text[])
      AND NOT EXISTS (SELECT 1 FROM professional_punch_activity l WHERE l.professional_id=p.id
        AND l.attendance_date=$2::date AND l.action='pm_allow' AND l.actor_id=a.professional_id)`, [employeeId,date,stage,roles]);
}
async function getPunchSettings(client=pool) {
  await ensurePunchCutoffSchema();
  return (await client.query('SELECT enabled,updated_by,updated_at FROM professional_punch_settings WHERE id=1')).rows[0];
}
async function loadPunchApprovals(client, ids, start, end=start) {
  if (!ids.length) return new Map();
  const {rows}=await client.query(`SELECT l.professional_id,l.attendance_date::text AS date,l.action,l.created_at,l.note,
    actor.full_name AS actor_name FROM professional_punch_activity l JOIN professional_employees actor ON actor.id=l.actor_id
    WHERE l.professional_id=ANY($1::uuid[]) AND l.attendance_date BETWEEN $2::date AND $3::date
      AND l.action IN ('pm_allow','pm_reject','ho_allow','ho_reject','hod_allow','hod_reject') ORDER BY l.id`,[ids,start,end]);
  const byRecord=new Map();
  for(const row of rows) {
    const key=row.professional_id+row.date;
    if(!byRecord.has(key)) byRecord.set(key,[]);
    byRecord.get(key).push(row);
  }
  return byRecord;
}
function approvalProgress(record, reviews=[]) {
  if(!record?.attempted_punch_in) return null;
  const hod=reviews.filter(r=>r.action.startsWith('hod_')).at(-1);
  const stage=(review,status)=>({status,reviewer_name:review?.actor_name || null,reviewed_at:review?.created_at || null,note:review?.note || null});
  if(record.punch_approval_status==='pending_hod'||hod)return {hod:stage(hod,hod?(hod.action==='hod_allow'?'approved':'rejected'):'pending')};
  const pm=reviews.filter(r=>r.action.startsWith('pm_')).at(-1);
  const ho=reviews.filter(r=>r.action.startsWith('ho_')).at(-1);
  return {
    pm:stage(pm,pm ? (pm.action==='pm_allow' ? 'approved' : 'rejected') : 'pending'),
    ho:stage(ho,ho ? (ho.action==='ho_allow' ? 'approved' : 'rejected') : pm?.action==='pm_reject' ? 'not_required' : record.punch_approval_status==='pending_ho' ? 'pending' : 'waiting_for_pm'),
  };
}
module.exports = { ensurePunchCutoffSchema, markPunchCutoffSchemaReady, capabilities, nextDecision, notifyStage, PM_ROLES, getPunchSettings, loadPunchApprovals, approvalProgress };
