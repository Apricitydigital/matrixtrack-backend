// Isolated PostgreSQL fixture: never reads application .env or connects to live data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {PGlite}=require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
const db=new PGlite();
const routes=[],middleware=[];
const router={use:fn=>middleware.push(fn)};
for(const verb of ['get','post','patch','delete'])router[verb]=(route,...handlers)=>routes.push({verb,route,handlers});
const pool={query:(sql,params)=>params ? db.query(sql,params) : db.exec(sql).then(results=>results.at(-1)),connect:async()=>({query:(sql,params)=>db.query(sql,params),release(){}})};
const filename=path.join(__dirname,'../routes/workforceReviewRoutes.js');
const mocks={express:{Router:()=>router},'../config/db':pool,'../middleware/authMiddleware':(req,res,next)=>next(),
 '../middleware/cityScope':{attachCityScope:(req,res,next)=>{req.cityScope={all:req.user.user_id!==3,ids:[1]};next();}},
 '../middleware/permissionMiddleware':{authorize:(_module,action)=>(req,res,next)=>req.reviewActor.user_id===4 || (req.reviewActor.user_id===3 && action==='write') ? res.status(403).json({message:'Forbidden'}) : next(),getPermissionCityFilter:req=>req.cityScope.all ? null : req.cityScope.ids},
 '../utils/userKothiAccess':{fetchUserKothiAccess:async()=>({ids:[10]})}};
vm.runInNewContext('(function(require,module,__dirname){'+fs.readFileSync(filename,'utf8')+'})',{console,process})(name=>mocks[name] || require(require.resolve(name,{paths:[path.dirname(filename)]})),{exports:{}},path.dirname(filename));
async function call(verb,route,{user=1,body={},query={},params={}}={}){
 const req={user:{user_id:user},body,query,params};
 const res={code:200,status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
 const match=routes.find(r=>r.verb===verb && r.route===route);assert.ok(match);
 for(const fn of [...middleware,...match.handlers]){let next=false;await fn(req,res,()=>{next=true;});if(!next)break;}
 return res;
}
const pro='11111111-1111-4111-8111-111111111111',pro2='22222222-2222-4222-8222-222222222222';
(async()=>{
 await db.exec(`CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,email TEXT,role TEXT,permissions JSONB,is_deleted BOOLEAN DEFAULT FALSE);
 INSERT INTO users VALUES(1,'Owner','owner@example.test','super_admin',NULL,false),(2,'Supervisor','s@example.test','supervisor',NULL,false),(3,'Scoped admin','a@example.test','admin','{}',false),(4,'No access','b@example.test','admin','{}',false);
 CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT); INSERT INTO cities VALUES(1,'One'),(2,'Two');
 CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT);INSERT INTO zones VALUES(1,1),(2,2);
 CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT,ward_name TEXT);INSERT INTO wards VALUES(10,1,'Site one'),(20,2,'Site two');
 CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT,ward_id INT,face_id TEXT,face_embedding TEXT,is_deleted BOOLEAN);
 INSERT INTO employee VALUES(1,'Ashutosh','R1','999',10,'face',NULL,false),(2,'Ashutosh','R2','998',NULL,NULL,NULL,true),(3,'Elsewhere','R3','997',20,NULL,NULL,false);
 CREATE TABLE attendance(id SERIAL PRIMARY KEY,emp_id INT REFERENCES employee,date DATE,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,mid_shift_punch_in_time TIMESTAMP,leave_type TEXT);
 INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(1,'2026-10-21','2026-10-21 09:00');
 INSERT INTO attendance(emp_id,date,leave_type) VALUES(1,'2026-10-21','casual');
 CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,mobile TEXT,city_id INT,kothi_id INT,is_active BOOLEAN,selfie_url TEXT);
 INSERT INTO professional_employees VALUES('${pro}','Ashutosh','P1','999',1,10,false,'photo'),('${pro2}','Ashutosh','P2','996',1,10,true,NULL);
 CREATE TABLE professional_attendance(id SERIAL PRIMARY KEY,professional_id UUID REFERENCES professional_employees,date DATE,punch_in TIMESTAMP,punch_out TIMESTAMP);
 INSERT INTO professional_attendance(professional_id,date,punch_in) VALUES('${pro}','2026-10-21','2026-10-21 09:00');
 CREATE TABLE professional_leave_requests(id SERIAL PRIMARY KEY,professional_id UUID REFERENCES professional_employees,requested_date DATE,status TEXT);
 INSERT INTO professional_leave_requests(professional_id,requested_date,status) VALUES('${pro2}','2026-10-21','approved');
 CREATE TABLE leave_notes(id SERIAL PRIMARY KEY,request_id INT REFERENCES professional_leave_requests,note TEXT);
 INSERT INTO leave_notes(request_id,note) SELECT id,'keep or delete with parent' FROM professional_leave_requests;`);
 const dates={startDate:'2026-10-21',endDate:'2026-10-21'};
 let r=await call('post','/summary',{body:dates});assert.equal(r.code,200);assert.equal(r.data.data.totalEmployees,5);assert.equal(r.data.data.present,2);assert.equal(r.data.data.onLeave,1);assert.equal(r.data.data.notMarked,2);assert.equal(r.data.data.breakdown.professional.totalEmployees,2);
 r=await call('post','/summary',{body:{...dates,user_id:7}});assert.equal(r.data.data.totalEmployees,3);
 r=await call('get','/',{query:{...dates,search:'ashutosh'}});assert.equal(r.code,200);assert.equal(r.data.total,4);assert.ok(r.data.data.every(row=>row.signals.includes('Same name')));assert.ok(r.data.data.some(row=>row.deleted==='true'));assert.equal(r.data.canHardDelete,true);
 for (const [kind,status,total] of [['all','all',5],['professional','all',2],['all','present',2],['all','notMarked',2],['all','onLeave',1],['all','faceRegistered',2],['regular','midShiftPunchIn',0]]) {
   const details=await call('get','/',{query:{...dates,kind,status}});
   assert.equal(details.code,200);
   assert.equal(details.data.total,total,`${kind}/${status} detail count must match its dashboard card`);
   if(['present','notMarked','onLeave'].includes(status)) assert.ok(details.data.data.every(row=>row.status===status));
   if(kind!=='all') assert.ok(details.data.data.every(row=>row.kind===kind));
 }
 assert.equal((await call('get','/',{user:2})).code,403);assert.equal((await call('get','/',{user:4})).code,403);
 r=await call('get','/',{user:3,query:dates});assert.equal(r.data.total,3);assert.equal(r.data.canHardDelete,false);
 assert.equal((await call('post','/:kind/:id/issues',{user:3,params:{kind:'regular',id:'1'},body:{reason:'duplicate'}})).code,403);
 const params={kind:'professional',id:pro};
 assert.equal((await call('get','/:kind/:id/delete-preview',{user:3,params})).code,403);
 assert.equal((await call('delete','/:kind/:id',{user:3,params,body:{confirmation:pro,reason:'Forbidden delete'}})).code,403);
 r=await call('post','/:kind/:id/issues',{params,body:{reason:'Review duplicate employee'}});assert.equal(r.code,201);const issueId=r.data.data.id;
 r=await call('patch','/:kind/:id/issues/:issueId',{params:{...params,issueId},body:{status:'done'}});assert.equal(r.data.data.status,'done');
 r=await call('get','/',{query:{...dates,review:'done'}});assert.equal(r.data.total,1);
 r=await call('get','/:kind/:id/delete-preview',{params});assert.equal(r.code,200);let preview=r.data;assert.ok(preview.affected.some(a=>a.table==='professional_attendance'));
 r=await call('delete','/:kind/:id',{params,body:{reason:'Confirmed duplicate',confirmation:pro,fingerprint:'stale'}});assert.equal(r.code,409);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees')).rows[0].n,2);
 await db.query('UPDATE professional_employees SET is_active=true WHERE id=$1',[pro]);
 r=await call('delete','/:kind/:id',{params,body:{reason:'Changed row test',confirmation:pro,fingerprint:preview.fingerprint}});assert.equal(r.code,409);
 preview=(await call('get','/:kind/:id/delete-preview',{params})).data;
 r=await call('delete','/:kind/:id',{params,body:{reason:'Confirmed duplicate',confirmation:pro,fingerprint:preview.fingerprint}});assert.equal(r.code,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM workforce_deletion_audit')).rows[0].n,1);
 const params2={kind:'professional',id:pro2};
 r=await call('get','/:kind/:id/delete-preview',{params:params2});assert.ok(r.data.affected.some(a=>a.table==='leave_notes'));
 const nestedPreview=r.data;
 r=await call('delete','/:kind/:id',{params:params2,body:{reason:'Nested dependency test',confirmation:pro2,fingerprint:nestedPreview.fingerprint}});assert.equal(r.code,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM leave_notes')).rows[0].n,0);
 const regularParams={kind:'regular',id:'1'};
 const regularPreview=(await call('get','/:kind/:id/delete-preview',{params:regularParams})).data;
 r=await call('delete','/:kind/:id',{params:regularParams,body:{reason:'Regular employee fixture',confirmation:'1',fingerprint:regularPreview.fingerprint}});assert.equal(r.code,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM employee')).rows[0].n,2);
 console.log('PASS: raw inclusive counts, attendance priority, duplicate search, city scope, admin permissions, issue persistence, superadmin deletion, stale-preview rollback, nested dependencies and audit.');
 await db.close();
})().catch(async e=>{console.error(e);await db.close();process.exitCode=1;});
