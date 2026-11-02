'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
function builder(file,flat=true){
 const module={exports:{}};
 // Only the real, exported SQL builder is called; no handler/provider is run.
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers',file),'utf8'),{module,require:()=>({}),process:{env:{WARD_HIERARCHY:flat?'city_zone_ward':''}},console});
 return module.exports.buildWardAndKothiFilters;
}
for(const file of ['selfAttendanceReportsController.js','selfAttendanceLeaveManagementController.js']){
 test(file+': physical Ward filter excludes profiles whose retired Sector ID overlaps; old NULL-site punches remain visible',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE TABLE self_attendance_employees(id INT,city_id INT,ward_id INT,kothi_id INT);
    INSERT INTO self_attendance_employees VALUES(1,1,100,1001),(2,1,100,100),(3,1,NULL,1001),(4,2,100,2000);
    CREATE TABLE self_attendance_records(id INT,self_attendance_id INT,kothi_id INT,punch_in TIMESTAMPTZ);
    INSERT INTO self_attendance_records VALUES(10,1,NULL,'2026-10-01T03:30:00Z'),(20,2,100,'2026-10-01T03:30:00Z'),(30,3,1001,'2026-10-01T03:30:00Z');`);
   const build=builder(file);
   async function rows(site){const params=[1];const filter=build(null,String(site),params.length,params);assert.equal(filter.paramCount,2);
    return (await db.query(`SELECT a.id,pe.id AS employee_id FROM self_attendance_records a JOIN self_attendance_employees pe ON pe.id=a.self_attendance_id WHERE pe.city_id=$1 ${filter.sql} ORDER BY a.id`,params)).rows;}
   assert.deepEqual(await rows(100),[{id:20,employee_id:2}]);
   assert.deepEqual(await rows(1001),[{id:10,employee_id:1},{id:30,employee_id:3}]);
   assert.deepEqual(await rows(2000),[]);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM self_attendance_records')).rows[0].n,3);
  }finally{await db.close();}
 });
}
test('pre-cutover legacy Ward/Sector filter behavior remains available when flat hierarchy is disabled',()=>{
 for(const file of ['selfAttendanceReportsController.js','selfAttendanceLeaveManagementController.js']){
  const params=[],filter=builder(file,false)(null,'100',0,params);
  assert.match(filter.sql,/OR pe\.ward_id/);assert.deepEqual(params,['100']);assert.equal(filter.paramCount,1);
 }
});
