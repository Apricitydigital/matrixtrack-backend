const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const main='30330f41-8363-43f1-bd0d-b7dd24d56b98';
const source='30330f41-8363-43f1-bd0d-b7dd24d56b99';
const other='30330f41-8363-43f1-bd0d-b7dd24d56b97';
const response=()=>({code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
async function fixture(run){
 const db=new PGlite();try{
  await db.exec(fs.readFileSync('db/migrations/20260915_add_user_consent_logs.sql','utf8'));
  await db.exec(fs.readFileSync('db/migrations/20261023_consent_identity.sql','utf8'));
  await db.exec(`CREATE TABLE self_punch_requests(id UUID PRIMARY KEY,mobile TEXT,emp_code TEXT);
    CREATE TABLE workforce_employee_aliases(employee_kind TEXT,source_id TEXT,target_id TEXT);`);
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync('controllers/consentController.js','utf8'),{module,require:name=>name.includes('config/db')?db:{info(){},error(){}}});
  const api=module.exports;
  const status=async(id=main)=>{const res=response();await api.getConsentStatusApi({professional:{professional_id:id}},res);assert.equal(res.code,200);return res.body.consentGiven;};
  await run({db,api,status});
 }finally{await db.close();}
}
test('legacy registration consent requires the account request mobile and employee code',()=>fixture(async({db,api,status})=>{
 await db.query('INSERT INTO self_punch_requests VALUES($1,$2,$3),($4,$2,$5)',[main,'9000000001','MP001',other,'MP002']);
 await api.logUserConsent({mobile:'9000000001',empCode:'MP001'});
 assert.equal(await status(),true);assert.equal(await status(other),false);assert.equal(await status(source),false);
 await db.query('UPDATE self_punch_requests SET emp_code=NULL WHERE id=$1',[other]);
 await api.logUserConsent({mobile:'9000000001'});assert.equal(await status(other),false);
}));
test('registration UUID remains recognised after location or contact edits',()=>fixture(async({db,api,status})=>{
 await db.query('INSERT INTO self_punch_requests VALUES($1,$2,$3)',[main,'9000000001','MP001']);
 await api.logUserConsent({userId:main,mobile:'9000000001',empCode:'MP001'});
 await db.query('UPDATE self_punch_requests SET mobile=$1,emp_code=$2 WHERE id=$3',['9000000002','MP003',main]);
 assert.equal(await status(),true);
}));
test('a reviewed merge preserves source consent without granting unrelated or regular aliases consent',()=>fixture(async({db,api,status})=>{
 await api.logUserConsent({userId:source});assert.equal(await status(),false);
 await db.query('INSERT INTO workforce_employee_aliases VALUES($1,$2,$3)',['professional',source,main]);
 assert.equal(await status(),true);assert.equal(await status(other),false);
 await db.query("UPDATE workforce_employee_aliases SET employee_kind='regular'");assert.equal(await status(),false);
}));
test('legacy registration consent on a merged source remains recognised',()=>fixture(async({db,api,status})=>{
 await db.query('INSERT INTO self_punch_requests VALUES($1,$2,$3)',[source,'9000000001','MP001']);
 await db.query("INSERT INTO workforce_employee_aliases VALUES('professional',$1,$2)",[source,main]);
 await api.logUserConsent({mobile:'9000000001',empCode:'MP001'});assert.equal(await status(),true);
}));
test('proxy consent and another version do not grant professional self consent',()=>fixture(async({db,api,status})=>{
 await db.query('INSERT INTO self_punch_requests VALUES($1,$2,$3)',[main,'9000000001','MP001']);
 await api.logUserConsent({mobile:'9000000001',empCode:'MP001',actorType:'SUPERVISOR_PROXY',supervisorId:4});
 await api.logUserConsent({userId:main,consentVersion:'v0.9'});assert.equal(await status(),false);
}));
test('latest negative consent wins across a reviewed merge',()=>fixture(async({db,api,status})=>{
 await db.query("INSERT INTO workforce_employee_aliases VALUES('professional',$1,$2)",[source,main]);
 await api.logUserConsent({userId:source});await api.logUserConsent({userId:main,consentGiven:false});assert.equal(await status(),false);
}));
test('save uses authenticated canonical identity despite stale or spoofed body fields',()=>fixture(async({db,api,status})=>{
 const res=response();
 await api.recordConsentApi({professional:{professional_id:main},body:{userId:source,actorType:'SUPERVISOR_PROXY',supervisorId:4,mobile:'9000000001',consentGiven:true,language:'hi'},ip:'127.0.0.1'},res);
 assert.equal(res.code,201);
 const row=(await db.query('SELECT * FROM user_consent_logs')).rows[0];
 assert.equal(row.user_id,main);assert.equal(row.actor_type,'SELF');assert.equal(row.supervisor_id,0);assert.equal(row.mobile,null);
 assert.equal(await status(),true);assert.equal(await status(source),false);
}));
test('decline and truthy strings never save accepted consent',()=>fixture(async({db,api})=>{
 for(const consentGiven of [false,'false','true']){const res=response();await api.recordConsentApi({professional:{professional_id:main},body:{consentGiven}},res);assert.equal(res.code,400);}
 assert.equal((await db.query('SELECT count(*)::int AS count FROM user_consent_logs')).rows[0].count,0);
}));
test('direct consent works without optional registration and merge tables',()=>fixture(async({db,api,status})=>{
 await db.exec('DROP TABLE self_punch_requests; DROP TABLE workforce_employee_aliases;');
 await api.logUserConsent({userId:main});assert.equal(await status(),true);
}));
