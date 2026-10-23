// Isolated fixture extension: real bcrypt/JWT and production login/OTP handlers.
// SMS delivery is replaced; nothing is sent and no application .env is loaded.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const loginHelpers=require('../utils/professionalMergeLogin');
module.exports=async({db,pool,call})=>{
 const secret='offline-credential-merge-fixture';
 const logger={info(){},warn(){},error:(...args)=>console.error(...args)};
 const load=(relative,deps={})=>{
  const file=path.join(__dirname,relative),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,__dirname:path.dirname(file),console,Buffer,
   process:{env:{JWT_SECRET:secret,NODE_ENV:'test'}},
   require:name=>{
    if(Object.hasOwn(deps,name))return deps[name];
    if(name==='../config/db')return pool;
    if(name==='../utils/logger')return logger;
    if(name==='../utils/professionalMergeLogin')return loginHelpers;
    if(['fs','path','jsonwebtoken','bcryptjs'].includes(name))return require(name);
    throw Error(`Unexpected fixture dependency ${name}`);
   }});return module.exports;
 };
 const aliases=load('../utils/employeeAliases.js');
 const aliasDeps={'../utils/employeeAliases':aliases};
 let auth=load('../controllers/professionalAuthController.js',aliasDeps);
 const middleware=load('../middleware/professionalAuth.js',aliasDeps);
 const sms=[];
 const otp=load('../controllers/professionalOtpController.js',{...aliasDeps,'../utils/smsNotifier':{sendSms:async(...args)=>{sms.push(args);}}});
 await db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
 const result=()=>({code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
 const login=async(email,password)=>{const res=result();await auth.login({body:{email,password}},res);return res;};
 const otpRequest=async mobile=>{const res=result();await otp.sendOtp({body:{mobile}},res);assert.equal(res.code,200,JSON.stringify(res.body));return (await db.query('SELECT otp FROM professional_otp_sessions WHERE mobile=$1',[loginHelpers.normalizeMobile(mobile)])).rows[0].otp;};
 const otpVerify=async(mobile,code)=>{const res=result();await otp.verifyOtp({body:{mobile,otp:code}},res);return res;};
 const assertLogin=async(identifier,password,id)=>{
  const res=await login(identifier,password);assert.equal(res.code,200,JSON.stringify(res.body));
  assert.equal(res.body.professional.id,id);assert.equal(jwt.verify(res.body.token,secret).professional_id,id);
  assert.ok(!JSON.stringify(res.body).includes('$2'),'No password hash is returned to the client');
 };
 const ids=[1,2,3,4].map(n=>`c0000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
 const mainPassword='Working-main-password-1',sourcePassword='Different-retired-password-2',resetPassword='Reset-main-password-3',finalPassword='Final-main-password-4';
 const hashes=[await bcrypt.hash(mainPassword,4),await bcrypt.hash(mainPassword,4),await bcrypt.hash(sourcePassword,4),await bcrypt.hash(finalPassword,4)];
 assert.notEqual(hashes[0],hashes[1],'The same cleartext password has independently salted hashes');
 for(const [i,id] of ids.entries())await db.query(`INSERT INTO professional_employees(id,full_name,emp_code,mobile,email,password_hash,selfie_url,is_active,city_id,zone_id,ward_id,kothi_id)
 VALUES($1,'Ashu Credential','ASHU-CRED',$2,$3,$4,$5,TRUE,1,1,10,10)`,[id,`989000000${i}`,`ashu-${i}@example.test`,hashes[i],i===0?'working-main-face':`retired-face-${i}`]);
 const before=(await db.query('SELECT to_jsonb(p) AS profile FROM professional_employees p WHERE id=$1',[ids[0]])).rows[0].profile;
 const oldToken=jwt.sign({professional_id:ids[2],city_id:999},secret,{expiresIn:'1h'});
 const pendingOtp=await otpRequest('9890000002');
 const params={kind:'professional',id:ids[0]},body={sourceIds:ids.slice(1,3)};
 const preview=await call('post','/:kind/:id/merge-preview',{params,body});assert.equal(preview.code,200,JSON.stringify(preview.data));
 const previewText=JSON.stringify(preview.data);
 for(const hash of hashes)assert.ok(!previewText.includes(hash),'Preview must never expose credential hashes');
 assert.equal(preview.data.login.email,'ashu-0@example.test');
 for(const identityConfirmed of [undefined,false]) {
  const missing=await call('post','/:kind/:id/merge',{params,body:{...body,identityConfirmed,reason:'Verified person',confirmation:ids[0],fingerprint:preview.data.fingerprint}});
  assert.equal(missing.code,400,'The API must require the explicit same-person and main-account acknowledgement');
 }
 const merged=await call('post','/:kind/:id/merge',{params,body:{...body,identityConfirmed:true,reason:'Same person verified; keep working account',confirmation:ids[0],fingerprint:preview.data.fingerprint}});
 assert.equal(merged.code,200,JSON.stringify(merged.data));
 assert.deepEqual((await db.query('SELECT to_jsonb(p) AS profile FROM professional_employees p WHERE id=$1',[ids[0]])).rows[0].profile,before,'Main profile, password and enrolled face stay byte-for-byte unchanged');
 await assertLogin('ashu-0@example.test',mainPassword,ids[0]);
 await assertLogin('ashu-1@example.test',mainPassword,ids[0]);
 await assertLogin('ashu-2@example.test',sourcePassword,ids[0]);
 await assertLogin('+919890000002',sourcePassword,ids[0]);
 await assertLogin('ASHU-2@EXAMPLE.TEST',mainPassword,ids[0]);
 assert.equal((await login('ashu-2@example.test','wrong-password')).code,401);
 assert.equal((await login('unrelated9890000002@example.test',sourcePassword)).code,401,'An arbitrary email containing phone digits is not a phone alias');
 const req={cookies:{},header:()=>`Bearer ${oldToken}`};let continued=false;const res=result();
 await middleware(req,res,()=>{continued=true;});assert.equal(continued,true);assert.equal(req.professional.professional_id,ids[0]);
 const during=await otpVerify('9890000002',pendingOtp);assert.equal(during.code,200,JSON.stringify(during.body));assert.equal(jwt.verify(during.body.token,secret).professional_id,ids[0]);
 const afterOtp=await otpRequest('9890000002');const after=await otpVerify('9890000002',afterOtp);
 assert.equal(after.code,200);assert.equal(jwt.verify(after.body.token,secret).professional_id,ids[0]);assert.ok(sms.length>=2);
 console.log('PASS: independently salted hashes, different retired passwords/identifiers/face references, main profile unchanged, required admin acknowledgement, old JWT and in-flight/new OTP continuity.');
 await db.query('UPDATE professional_employees SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(resetPassword,4),ids[0]]);
 assert.equal((await login('ashu-1@example.test',mainPassword)).code,401);
 assert.equal((await login('ashu-2@example.test',sourcePassword)).code,401);
 await assertLogin('ashu-2@example.test',resetPassword,ids[0]);
 // A second merge must flatten credential routing without reviving passwords
 // already invalidated by the first main account's password reset.
 const nextParams={kind:'professional',id:ids[3]},nextBody={sourceIds:[ids[0]]};
 await db.query("UPDATE workforce_merge_audit SET restore_until=NOW()-INTERVAL '1 second' WHERE target_id=$1",[ids[0]]);
 const nextPreview=await call('post','/:kind/:id/merge-preview',{params:nextParams,body:nextBody});assert.equal(nextPreview.code,200,JSON.stringify(nextPreview.data));
 const chained=await call('post','/:kind/:id/merge',{params:nextParams,body:{...nextBody,identityConfirmed:true,reason:'Move to final working main account',confirmation:ids[3],fingerprint:nextPreview.data.fingerprint}});
 assert.equal(chained.code,200,JSON.stringify(chained.data));
 assert.equal(await aliases.resolveEmployeeAlias('professional',ids[2]),ids[3]);
 assert.equal((await login('ashu-1@example.test',mainPassword)).code,401);
 assert.equal((await login('ashu-2@example.test',sourcePassword)).code,401);
 await assertLogin('ashu-0@example.test',resetPassword,ids[3]);
 await assertLogin('ashu-2@example.test',finalPassword,ids[3]);
 await db.query('UPDATE professional_employees SET is_active=FALSE WHERE id=$1',[ids[3]]);
 assert.equal((await login('ashu-2@example.test',finalPassword)).code,403);
 const inactiveOtp=await otpVerify('9890000002',await otpRequestAfterInactive());
 async function otpRequestAfterInactive(){
  // A real OTP issued before deactivation must not authenticate an inactive main.
  await db.query('UPDATE professional_employees SET is_active=TRUE WHERE id=$1',[ids[3]]);
  const code=await otpRequest('9890000002');
  await db.query('UPDATE professional_employees SET is_active=FALSE WHERE id=$1',[ids[3]]);return code;
 }
 assert.equal(inactiveOtp.code,403);
 await db.query('UPDATE professional_employees SET is_active=TRUE WHERE id=$1',[ids[3]]);
 // Legacy deployments name the bcrypt column "password". Re-read schema with
 // a fresh controller, as a process restart would, and verify the same routing.
 await db.exec('ALTER TABLE professional_employees RENAME COLUMN password_hash TO password');
 auth=load('../controllers/professionalAuthController.js',aliasDeps);
 await assertLogin('ashu-2@example.test',finalPassword,ids[3]);
 await assertLogin('ashu-0@example.test',resetPassword,ids[3]);
 console.log('PASS: main-password reset invalidates retired passwords, chained merges never revive them, inactive account guards, legacy password-column compatibility and no credential leakage.');
};
