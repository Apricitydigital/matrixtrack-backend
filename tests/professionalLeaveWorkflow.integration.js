// Exercises the real controllers and SQL in isolated PostgreSQL. No live services.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
async function main() {
  const db = new PGlite();
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const client = { release() {}, query: (sql, params) => db.query(sql, params) };
  const pool = { query: client.query, connect: async () => client };
  const load = (file, deps) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,file),'utf8'), { module, require: name => {
      if (!(name in deps)) throw Error(`Unexpected dependency ${name}`); return deps[name];
    }, console, process, __dirname: path.join(__dirname,'../utils') });
    return module.exports;
  };
  try {
    await db.exec(`CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT);
      CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT);
      CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,kothi_id INT,is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT);
      CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT);
      CREATE TABLE professional_site_access(professional_id UUID,kothi_id INT);
      CREATE TABLE professional_attendance(professional_id UUID,date DATE,punch_in TIMESTAMPTZ,attempted_punch_in TIMESTAMPTZ);
      CREATE TABLE professional_leave_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),professional_id UUID,requested_date DATE,leave_type TEXT,reason TEXT,status TEXT DEFAULT 'pending',requested_at TIMESTAMPTZ DEFAULT NOW(),reviewed_by INT,reviewed_at TIMESTAMPTZ,review_note TEXT,UNIQUE(professional_id,requested_date));
      CREATE TABLE professional_leave_request_logs(id UUID DEFAULT gen_random_uuid(),request_id UUID,action TEXT,actor_type TEXT,actor_professional_id UUID,actor_user_id INT,note TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE professional_leave_allocations(professional_id UUID,leave_type TEXT,period TEXT,allocated_count INT);
      CREATE TABLE professional_notifications(id UUID DEFAULT gen_random_uuid(),professional_id UUID,type TEXT,title TEXT,message TEXT,metadata JSONB);
      CREATE FUNCTION professional_is_week_off(UUID,DATE) RETURNS BOOLEAN LANGUAGE SQL AS $$ SELECT EXTRACT(DOW FROM $2)=0 $$;
      CREATE FUNCTION professional_week_off_days_at(UUID,DATE) RETURNS INT[] LANGUAGE SQL AS $$ SELECT ARRAY[0] $$;
      INSERT INTO wards VALUES(1,'Assigned'),(2,'Outside');
      INSERT INTO designation VALUES(1,'Project Head / Site Head'),(2,'HO Coordinator'),(3,'Head of Department');
      INSERT INTO professional_employees VALUES('${id(1)}','Employee','E1',1,TRUE),('${id(2)}','Project Head','PM',1,TRUE),('${id(3)}','HO','HO',1,TRUE),('${id(4)}','Country','CH',1,TRUE),('${id(5)}','Outside','O',2,TRUE),('${id(6)}','Dual role','D',1,TRUE);
      INSERT INTO professional_designation_assignments VALUES('${id(2)}',1),('${id(3)}',2),('${id(4)}',3),('${id(5)}',1),('${id(6)}',1),('${id(6)}',2);
      INSERT INTO professional_site_access VALUES('${id(2)}',1),('${id(3)}',1),('${id(4)}',1),('${id(5)}',2),('${id(6)}',1);
      INSERT INTO professional_leave_allocations VALUES('${id(1)}','CASUAL','monthly',2),('${id(1)}','CASUAL','yearly',3),('${id(2)}','CASUAL','monthly',2);
    `);
    const migration = fs.readFileSync(path.join(__dirname,'../db/migrations/20261015_professional_leave_workflow.sql'),'utf8');
    await db.exec(migration); await db.exec(migration);
    const expiryMigration=fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_leave_expiry.sql'),'utf8');
    await db.exec(expiryMigration);await db.exec(expiryMigration);
    const hodMigration=fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_hod_leave_approval.sql'),'utf8');
    await db.exec(hodMigration);await db.exec(hodMigration);
    const punch = load('../utils/professionalPunchCutoff.js', { fs, path, '../config/db': pool });
    const utility = load('../utils/professionalLeaveWorkflow.js', { './professionalPunchCutoff': punch });
    const controller = load('../controllers/professionalLeaveWorkflowController.js', {
      '../config/db': pool, '../utils/professionalLeaveSchema': { ensureProfessionalLeaveSchema: async () => {} },
      '../utils/professionalPunchCutoff': punch, '../utils/professionalWeeklyOff': { todayIST: () => '2026-10-15' }, '../utils/professionalLeaveWorkflow': utility,
    });
    const call = async (method, actor, options = {}) => {
      const req = { professional: { professional_id: id(actor) }, body: {}, params: {}, query: {}, ...options };
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await controller[method](req,res); return res;
    };
    const submit = (date,actor=1,type='CASUAL') => call('requestLeave',actor,{body:{date,leave_type:type,reason:'Family work'}});
    const review = (request, actor, decision='allow') => call('review',actor,{params:{id:request},body:{decision,note:decision==='reject'?'Not available':'Verified'}});
    assert.equal((await submit('2026-10-14')).code,400);
    assert.equal((await submit('2026-02-30')).code,400);
    assert.equal((await submit('2026-10-18')).code,400,'Assigned week off must not consume leave');
    assert.equal((await submit('2026-10-16',1,'MEDICAL')).code,400,'Unallocated type is denied');
    const first = await submit('2026-10-16'); assert.equal(first.code,200); const request=first.body.data.id;
    assert.equal(first.body.data.status,'pending'); assert.equal(first.body.data.approval_stage,'pending_pm');
    assert.equal((await submit('2026-10-16')).code,409);
    const second=await submit('2026-10-17'); assert.equal(second.code,200);
    assert.equal((await submit('2026-10-19')).code,400,'Pending requests reserve quota');
    assert.equal((await review(request,3)).code,403,'HO cannot approve before PM');
    assert.equal((await review(request,4)).code,403,'Head of Department is read only');
    assert.equal((await review(request,5)).code,403,'Other site cannot review');
    assert.equal((await call('getTeamRequests',1)).code,403);
    assert.equal((await call('getTeamRequests',5)).body.data.length,0);
    const pm=await review(request,2); assert.equal(pm.code,200); assert.equal(pm.body.data.status,'pending'); assert.equal(pm.body.data.approval_stage,'pending_ho');
    assert.equal((await review(request,2)).code,403,'PM cannot approve HO stage');
    const ho=await review(request,3); assert.equal(ho.code,200); assert.equal(ho.body.data.status,'approved');
    assert.equal((await review(request,3)).code,409,'Repeated review is blocked');
    assert.equal((await submit('2026-10-16')).code,409,'Approved request cannot be overwritten');
    const personal=await call('getMyLeaveRequests',1,{query:{month:'2026-10'}});
    const approved=personal.body.data.find(r=>r.id===request);
    assert.equal(approved.pm_reviewer_name,'Project Head'); assert.equal(approved.ho_reviewer_name,'HO');
    assert.equal(approved.history.length,3); assert.equal(approved.history[1].old_values.approval_stage,'pending_pm');
    assert.equal(approved.history[1].new_values.approval_stage,'pending_ho');
    assert.equal(approved.history[2].actor_name,'HO');
    const balance=await call('getBalance',1,{query:{date:'2026-10-20'}});
    assert.equal(balance.body.data.balance[0].remaining,0);
    assert.equal(balance.body.data.balance[0].used,1); assert.equal(balance.body.data.balance[0].reserved,1);
    assert.equal((await review(second.body.data.id,2,'reject')).code,200);
    assert.equal((await submit('2026-10-17')).code,200,'Rejected request can be resubmitted with a new audit entry');
    assert.equal((await review(second.body.data.id,6)).code,200);
    assert.equal((await review(second.body.data.id,6)).code,403,'Dual role cannot review both stages');
    await db.query('UPDATE professional_leave_allocations SET allocated_count=1 WHERE professional_id=$1 AND period=$2',[id(1),'monthly']);
    assert.equal((await review(second.body.data.id,3)).code,400,'Quota is rechecked at final approval');
    assert.equal((await review(second.body.data.id,3,'reject')).code,200);
    const self=await submit('2026-10-20',2); assert.equal(self.code,200);
    assert.equal((await review(self.body.data.id,2)).code,403,'No self approval');
    await db.query('INSERT INTO professional_leave_allocations VALUES($1,$2,$3,3)',[id(3),'CASUAL','monthly']);
    const hoSelf=await submit('2026-10-20',3);assert.equal(hoSelf.code,200);assert.equal(hoSelf.body.data.approval_stage,'pending_hod');assert.equal(hoSelf.body.data.approval_route,'hod');
    assert.equal((await review(hoSelf.body.data.id,2)).code,403,'PM cannot review HO own leave');
    assert.equal((await review(hoSelf.body.data.id,3)).code,403,'No HO self approval');
    assert.equal((await review(hoSelf.body.data.id,6)).code,403,'Another HO cannot approve HO leave');
    assert.equal((await review(hoSelf.body.data.id,5)).code,403,'Other site cannot approve');
    const hodList=(await call('getTeamRequests',4)).body.data.find(r=>r.id===hoSelf.body.data.id);assert.equal(hodList.can_review,true);
    const hodApproval=await review(hoSelf.body.data.id,4);assert.equal(hodApproval.body.data.status,'approved');assert.equal(hodApproval.body.data.hod_reviewer_id,id(4));
    const hoOwn=(await call('getMyLeaveRequests',3)).body.data.find(r=>r.id===hoSelf.body.data.id);assert.equal(hoOwn.hod_reviewer_name,'Country');assert.equal(hoOwn.history.at(-1).new_values.hod_note,'Verified');
    assert.equal((await review(hoSelf.body.data.id,4)).code,409);
    const hoRejected=await submit('2026-10-21',3);assert.equal((await review(hoRejected.body.data.id,4,'reject')).body.data.status,'rejected');
    const hoResubmitted=await submit('2026-10-21',3);assert.equal(hoResubmitted.body.data.approval_stage,'pending_hod');assert.equal(hoResubmitted.body.data.hod_reviewer_id,null);
    assert.ok((await db.query("SELECT 1 FROM professional_notifications WHERE professional_id=$1 AND metadata->>'stage'='pending_hod'",[id(4)])).rows.length);
    const legacyHo=(await db.query("INSERT INTO professional_leave_requests(professional_id,requested_date,leave_type,status,approval_stage) VALUES($1,'2090-01-01','CASUAL','pending','pending_ho') RETURNING id",[id(3)])).rows[0];
    await db.exec(hodMigration);await db.exec(hodMigration);
    const rerouted=(await db.query('SELECT * FROM professional_leave_requests WHERE id=$1',[legacyHo.id])).rows[0];assert.equal(rerouted.approval_stage,'pending_hod');
    const routingLog=(await db.query('SELECT * FROM professional_leave_request_logs WHERE request_id=$1',[legacyHo.id])).rows;assert.equal(routingLog.length,1);assert.equal(routingLog[0].actor_type,'system');assert.equal(routingLog[0].old_values.approval_stage,'pending_ho');
    console.log('PASS: HO leave goes directly to HOD, final approval/rejection, resubmission, audit, notifications, self and role/site isolation.');
    const november=await submit('2026-11-02'); assert.equal(november.code,200,'Monthly quota follows requested date');
    const december=await submit('2026-12-01'); assert.equal(december.code,200);
    assert.equal((await submit('2026-12-02')).code,400,'Yearly and monthly constraints both apply');
    await db.query('DELETE FROM professional_designation_assignments WHERE professional_id=$1',[id(2)]);
    assert.equal((await review(november.body.data.id,2)).code,403,'Designation revocation takes effect immediately');
    assert.equal((await review(november.body.data.id,6)).code,200);
    await db.query('INSERT INTO professional_attendance(professional_id,date,punch_in) VALUES($1,$2,$3)',[id(1),'2026-11-02','2026-11-02T04:00:00Z']);
    assert.equal((await review(november.body.data.id,3)).code,409,'Punch after submission prevents final leave approval');
    assert.equal((await review(november.body.data.id,3,'reject')).code,200);
    assert.equal((await call('getTeamRequests',4)).body.data.find(r=>r.id===december.body.data.id).can_review,false);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM professional_notifications WHERE professional_id=$1 AND metadata->>'stage'='pending_ho'`,[id(3)])).rows[0].n>0,true);
    const expiredRequests=(await db.query(`INSERT INTO professional_leave_requests(professional_id,requested_date,leave_type,status,approval_stage,pm_reviewer_id,pm_note)
      VALUES($1,'2026-10-15','CASUAL','pending','pending_pm',NULL,NULL),
      ($1,'2026-10-14','CASUAL','pending','pending_ho',$2,'Original PM approval') RETURNING id`,[id(1),id(6)])).rows;
    assert.equal((await review(expiredRequests[1].id,3)).code,409,'Stale requests cannot be approved even before expiry cleanup');
    await db.query(`INSERT INTO professional_leave_requests(professional_id,requested_date,leave_type,status,approval_stage)
      VALUES($1,'2026-10-16','CASUAL','pending','pending_pm'),($1,'2026-10-17','CASUAL','pending','pending_pm'),
      ($1,'2026-10-13','CASUAL','approved','accepted'),($1,'2026-10-12','CASUAL','rejected','rejected')`,[id(2)]);
    const beforeReserved=(await utility.balances(pool,id(1),'2026-10-16')).find(b=>b.period==='monthly').reserved;
    assert.equal((await db.query("SELECT professional_expire_pending_leaves('2026-10-16') AS n")).rows[0].n,2);
    assert.equal((await db.query("SELECT professional_expire_pending_leaves('2026-10-16') AS n")).rows[0].n,0,'Expiry is idempotent');
    for(const record of expiredRequests) {
      const row=(await db.query('SELECT * FROM professional_leave_requests WHERE id=$1',[record.id])).rows[0];
      assert.equal(row.status,'rejected');assert.equal(row.approval_stage,'rejected');assert.ok(row.auto_rejected_at);
      const logs=await db.query('SELECT * FROM professional_leave_request_logs WHERE request_id=$1',[record.id]);
      assert.equal(logs.rows.length,1);assert.equal(logs.rows[0].actor_type,'system');
      assert.equal(logs.rows[0].old_values.status,'pending');assert.equal(logs.rows[0].new_values.status,'rejected');
      assert.match(logs.rows[0].note,/date passed/);
      assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM professional_notifications WHERE metadata->>'request_id'=$1 AND metadata->>'automatic'='true'",[record.id])).rows[0].n,1);
    }
    assert.equal((await db.query('SELECT pm_note FROM professional_leave_requests WHERE id=$1',[expiredRequests[1].id])).rows[0].pm_note,'Original PM approval');
    for(const [date,status] of [['2026-10-16','pending'],['2026-10-17','pending'],['2026-10-13','approved'],['2026-10-12','rejected']]) {
      const row=(await db.query('SELECT * FROM professional_leave_requests WHERE professional_id=$1 AND requested_date=$2',[id(2),date])).rows[0];
      assert.equal(row.status,status);assert.equal(row.auto_rejected_at,null);
    }
    assert.equal((await utility.balances(pool,id(1),'2026-10-16')).find(b=>b.period==='monthly').reserved,beforeReserved-2,'Expiry releases quota reservations');
    const pending=(await call('getTeamRequests',3,{query:{status:'pending'}})).body.data;
    const rejected=(await call('getTeamRequests',3,{query:{status:'rejected'}})).body.data;
    for(const record of expiredRequests) {assert.ok(!pending.some(r=>r.id===record.id));assert.ok(rejected.some(r=>r.id===record.id && !r.can_review));}
    console.log('PASS: past PM/HO requests expire once, current/future and approved requests are preserved, audit/notifications persist and pending lists release expired requests.');
    console.log('PASS: PM → HO order, scope, self/dual-role denial, audit snapshots, reviewer names, notifications, quota reservation and period bounds, resubmission, week-off guard and live revocation.');
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
