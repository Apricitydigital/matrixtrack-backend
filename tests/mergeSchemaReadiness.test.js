const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm');
const {findSelfAttendanceLogin,findSelfAttendanceMobile}=require('../utils/selfAttendanceMergeLogin');
test('missing optional merge schema never executes DDL or blocks original IDs',async()=>{
 const statements=[];
 const pool={query:async(sql,params)=>{
  statements.push(sql);assert.match(sql,/^SELECT\b/i);
  if(sql.includes('FROM self_attendance_employees')){assert.ok(!sql.includes('workforce_self_attendance_login_aliases'));assert.equal(params.length,2);return {rows:[{id:'main',is_active:true}]};}
  return {rows:[{available:false}]};
 }};
 const moduleRef={exports:{}},file=path.join(__dirname,'../utils/employeeAliases.js');
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:moduleRef,require:name=>{assert.equal(name,'../config/db');return pool;}});
 const aliases=moduleRef.exports;
 assert.equal(await aliases.resolveEmployeeAlias('self_attendance','original'),'original');
 assert.equal(await aliases.hasLoginAliases(),false);
 await assert.rejects(aliases.ensureMergeSchema(),error=>error.status===503);
 const login=await findSelfAttendanceLogin(pool,'ashu@example.test','ashu@example.test','password_hash',false);
 assert.equal(login.self_attendance.id,'main');assert.deepEqual(login.retiredHashes,[]);
 assert.equal((await findSelfAttendanceMobile(pool,'9999999999',false)).rows[0].id,'main');
 assert.ok(statements.every(sql=>!/^\s*(CREATE|ALTER|DROP|BEGIN)\b/i.test(sql)));
});
