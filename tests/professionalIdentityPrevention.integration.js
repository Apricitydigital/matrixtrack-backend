// Isolated PostgreSQL fixture. Never connects to the configured/live database.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
process.env.AADHAR_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef';
const encryption=require('../utils/encryption');
const identity=require('../utils/professionalIdentity');
const db=new PGlite();
const connections=[];
let uploads=0;
// PGlite has one PostgreSQL connection. Emulate waiting transactions at the
// actual advisory-lock statement so concurrent controller calls see commits in
// order. Assert the production lock key/order rather than assuming a mutex.
let tail=Promise.resolve();
const acquire=async()=>{const previous=tail;let done;tail=new Promise(resolve=>{done=resolve;});await previous;return done;};
const pool={
  query:(sql,params)=>db.query(sql,params),
  connect:async()=>{
    const calls=[];connections.push(calls);
    let begin,unlock;
    const open=async()=>{if(!unlock){unlock=await acquire();await db.query(begin);}};
    return {release(){assert.equal(unlock,undefined,'Transaction must finish before releasing the connection');},async query(sql,params){
      calls.push(sql);
      if(sql.startsWith('BEGIN')){begin=sql;return {rows:[]};}
      if(!unlock){
        if(!begin?.endsWith('READ ONLY')) assert.equal(sql,"SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))",'Identity writers must acquire the common lock before reading');
        await open();
      }
      try{return await db.query(sql,params);}
      finally{if(sql==='COMMIT'||sql==='ROLLBACK'){unlock();unlock=undefined;}}
    }};
  },
};
const load=(file,deps)=>{
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers',file),'utf8'),{
    module,process,console,require:name=>{assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name];},
  });
  return module.exports;
};
const log={info(){},warn(){},error(){}};
const multer=()=>({fields:()=>null});multer.memoryStorage=()=>({});
const deps={
  '../config/db':pool,'../utils/logger':log,'../utils/encryption':encryption,'../utils/professionalIdentity':identity,
  multer,uuid:{v4:randomUUID},'../utils/s3SelfPunch':{uploadToS3:async()=>{uploads++;return 'fixture-photo';},deleteFromS3:async()=>{},getSignedS3Url:async x=>x},
  '../utils/socket':{},'../utils/cityTrafficCost':{},'./consentController':{logUserConsent:async()=>{}},
  '../utils/professionalDesignation':{},'../utils/professionalRequestFilters':require('../utils/professionalRequestFilters'),
  '../utils/professionalLocation':require('../utils/professionalLocation'),
  bcryptjs:{},'../utils/smsNotifier':{},
};
const registration=load('selfPunchController.js',deps);
const approval=load('supervisorSelfPunchController.js',deps);
const updates=load('approvedProfessionalController.js',{...deps,'./supervisorSelfPunchController':approval});
const response=()=>({code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
const submit=async overrides=>{
  const res=response();await registration.submitRequest({body:{full_name:'New Employee',mobile:'9333333333',email:'new@example.test',emp_code:'NEW',aadhar_number:'333333333333',city_id:2,zone_id:2,ward_id:2,...overrides},
    files:{aadhar_doc:[{mimetype:'application/pdf',buffer:Buffer.from('fixture')}],selfie:[{mimetype:'image/jpeg',buffer:Buffer.from('fixture')}]},headers:{}},res);return res;
};
const apply=async(rows,preview=false)=>{
  const res=response();await updates.updateApprovedList({body:{rows,preview},supervisorId:1},res);return res;
};
async function main(){
  try{
    await db.exec(`CREATE TABLE wards(ward_id INT PRIMARY KEY,sector_id INT);
      INSERT INTO wards VALUES(1,1),(2,2);
      CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,mobile TEXT,email TEXT,emp_code TEXT,aadhar_number TEXT,is_active BOOLEAN);
      CREATE TABLE self_punch_requests(id UUID PRIMARY KEY,full_name TEXT,mobile TEXT,email TEXT,emp_code TEXT,aadhar_number TEXT,status TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,aadhar_doc_url TEXT,selfie_url TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE employee(emp_id SERIAL PRIMARY KEY,emp_code TEXT,name TEXT,phone TEXT,designation_id INT);
      CREATE TABLE self_punch_request_logs(request_id UUID,action TEXT,performed_by_type TEXT,performed_by_id INT,note TEXT);
      CREATE TABLE professional_attendance(id SERIAL,professional_id UUID,date DATE,punch_in TIMESTAMPTZ);`);
    const owner=randomUUID(),second=randomUUID(),pending=randomUUID();
    const aadhaar='111111111111';
    assert.notEqual(encryption.encryptAadhar(aadhaar),encryption.encryptAadhar(aadhaar),'Fixture uses randomized ciphertext');
    for(const [id,code,mobile,email,plain] of [[owner,'MP01','+91 98765-43210',' Owner@Example.test ',aadhaar],[second,'EMP2','9222222222','second@example.test','222222222222']]){
      await db.query(`INSERT INTO professional_employees VALUES($1,'Existing Employee',$2,$3,$4,$5,false)`,[id,mobile,email,code,encryption.encryptAadhar(plain)]);
      await db.query(`INSERT INTO self_punch_requests(id,full_name,mobile,email,emp_code,aadhar_number,status,city_id,zone_id,ward_id) VALUES($1,'Existing Employee',$2,$3,$4,$5,'approved',1,1,1)`,[id,mobile,email,code,encryption.encryptAadhar(plain)]);
      await db.query(`INSERT INTO employee(emp_code,name,designation_id) VALUES($1,'Existing Employee',1)`,[code]);
    }
    await db.query(`INSERT INTO self_punch_requests(id,full_name,mobile,email,emp_code,aadhar_number,status,city_id,zone_id,ward_id)
      VALUES($1,'Pending Employee','9444444444','pending@example.test','PENDING',$2,'pending',2,2,2)`,[pending,encryption.encryptAadhar('444444444444')]);
    await db.query(`INSERT INTO professional_attendance(professional_id,date,punch_in) VALUES($1,'2026-09-01','2026-09-01T09:00:00+05:30')`,[owner]);
    const attendanceBefore=(await db.query('SELECT * FROM professional_attendance')).rows;
    for(const args of [{mobile:'9876543210'},{email:'owner@example.TEST'},{empCode:' m p 01 '}]){
      const found=await identity.findProfessionalIdentityConflict(pool,args);assert.equal(found.id,owner,'Formatting changes must not bypass an existing identity');
    }
    const conflict=await submit({aadhar_number:aadhaar});
    assert.equal(conflict.code,409,'Changing mobile, email, code and location cannot bypass Aadhaar');assert.equal(uploads,0);
    const pendingConflict=await submit({aadhar_number:'444444444444'});
    assert.equal(pendingConflict.code,409,'A pending Aadhaar also reserves the identity');assert.equal(uploads,0);
    const unique=await submit({mobile:'9555555555',email:'unique@example.test',emp_code:'UNIQUE',aadhar_number:'555555555555'});
    assert.equal(unique.code,201,'A distinct employee can still register');
    const beforeUploads=uploads;
    const simultaneous=await Promise.all([
      submit({mobile:'9666666666',email:'race1@example.test',emp_code:'RACE1',aadhar_number:'666666666666'}),
      submit({mobile:'9777777777',email:'race2@example.test',emp_code:'RACE2',aadhar_number:'666666666666'}),
    ]);
    assert.deepEqual(simultaneous.map(r=>r.code).sort(),[201,409],'Only one simultaneous same-person registration succeeds');
    assert.equal(uploads-beforeUploads,2,'The blocked registration uploads neither document nor selfie');
    const legacy=randomUUID();
    await db.query(`INSERT INTO self_punch_requests(id,full_name,mobile,email,emp_code,aadhar_number,status)
      VALUES($1,'Legacy Duplicate','9888888888','legacy@example.test','LEGACY',$2,'pending')`,[legacy,encryption.encryptAadhar(aadhaar)]);
    const approvalResult=response();
    await approval.approveRequest({params:{id:legacy},body:{},user:{role:'admin'},supervisorId:1},approvalResult);
    assert.equal(approvalResult.code,409,'Approval rechecks Aadhaar for requests created before the guard');
    assert.equal((await db.query('SELECT status FROM self_punch_requests WHERE id=$1',[legacy])).rows[0].status,'pending');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees')).rows[0].n,2);
    const uniqueRow=(await db.query('SELECT * FROM self_punch_requests WHERE id=$1',[unique.body.request_id])).rows[0];
    assert.equal(await identity.findProfessionalIdentityConflict(pool,{mobile:uniqueRow.mobile,email:uniqueRow.email,empCode:uniqueRow.emp_code,aadharNumber:uniqueRow.aadhar_number,requireAadhaar:true,excludeRequestId:uniqueRow.id}),null,'A request must not conflict with itself during approval');
    const current=(await db.query('SELECT * FROM self_punch_requests WHERE id=$1',[second])).rows[0];
    const timestamp=new Date(current.updated_at).toISOString();
    const reserved=await apply([{id:second,updated_at:timestamp,email:'PENDING@example.test'}]);
    assert.equal(reserved.code,400,'Approved updates cannot steal identifiers reserved by pending registrations');
    const duplicateAadhaar=await apply([{id:second,updated_at:timestamp,aadhar_number:aadhaar}]);
    assert.equal(duplicateAadhaar.code,400);assert.match(duplicateAadhaar.body.message,/Aadhaar belongs/);
    assert.ok(!JSON.stringify(duplicateAadhaar.body).includes(aadhaar),'Aadhaar conflict errors do not expose the full identifier');
    const ownerRow=(await db.query('SELECT * FROM self_punch_requests WHERE id=$1',[owner])).rows[0];
    const repeatedCode=await apply([
      {id:second,updated_at:timestamp,emp_code:'NEWCODE'},
      {id:owner,updated_at:new Date(ownerRow.updated_at).toISOString(),emp_code:'new code'},
    ]);
    assert.equal(repeatedCode.code,400);assert.equal(repeatedCode.body.errors.length,2,'Equivalent uploaded codes reject the whole batch');
    const repeatedAadhaar=await apply([
      {id:second,updated_at:timestamp,aadhar_number:'777777777777'},
      {id:owner,updated_at:new Date(ownerRow.updated_at).toISOString(),aadhar_number:'777777777777'},
    ]);
    assert.equal(repeatedAadhaar.code,400);assert.equal(repeatedAadhaar.body.errors.length,2);
    assert.ok(!JSON.stringify(repeatedAadhaar.body).includes('777777777777'));
    const validEdit=await apply([{id:second,updated_at:timestamp,email:'corrected@example.test'}]);
    assert.equal(validEdit.code,200);assert.equal(validEdit.body.changed,1,'Valid corrections update the permanent record');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees')).rows[0].n,2,'Updates never create replacement profiles');
    assert.deepEqual((await db.query('SELECT * FROM professional_attendance')).rows,attendanceBefore,'Prevention does not modify existing attendance');
    assert.ok(connections.length>=8);
    assert.ok(connections.every(c=>c[1]==="SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))"),'Registration, approval and apply use the same serialization lock');
    console.log('PASS: global encrypted Aadhaar duplicates, changed contact/code/location, normalized identifiers, pending reservations, concurrent registrations, legacy approval rejection, self exclusion, atomic upload conflicts, valid registration/correction and preserved attendance.');
  }finally{await db.close();}
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
