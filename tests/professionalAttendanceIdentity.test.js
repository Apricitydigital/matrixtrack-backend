const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const identity = require('../utils/professionalAttendanceIdentity');
const groups = require('../config/professionalAttendanceIdentities');

test('reviewed attendance links are explicit and UUID case independent', () => {
  const {primaryId,profileIds}=groups[0];
  for(const id of profileIds){
    assert.equal(identity.primaryAttendanceId(id.toUpperCase()),primaryId);
    assert.deepEqual(identity.attendanceSourceIds(id),profileIds);
  }
  const stranger='00000000-0000-4000-8000-000000000001';
  assert.equal(identity.primaryAttendanceId(stranger),stranger);
  assert.deepEqual(identity.attendanceSourceIds(stranger),[stranger]);
  assert.equal(identity.reviewedHistorySql(stranger),null);
  assert.throws(()=>identity.withAttendanceIdentity('DELETE FROM professional_attendance'),/read-only/);
});

test('rollback switch restores original report SQL and attendance account routing', async () => {
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/professionalAttendanceIdentity.js'),'utf8'),{
    module,process:{env:{PROFESSIONAL_ATTENDANCE_IDENTITY_LINKS_ENABLED:'false'}},
    require:()=>assert.fail('Disabled links must not load config or access the database'),
  });
  const off=module.exports;
  const {primaryId,profileIds}=groups[0];
  const sql='SELECT * FROM professional_attendance WHERE professional_id=$1';
  assert.equal(off.withAttendanceIdentity(sql,[primaryId]),sql);
  assert.equal(off.withAttendanceIdentity('SELECT full_name FROM attendance_identity_profile_names WHERE id=$1',[primaryId]),
    'SELECT full_name FROM professional_employees WHERE id=$1');
  assert.equal(off.reviewedPaidDaySql('pe.id','cd.date'),'professional_is_paid_day(pe.id,cd.date)');
  assert.equal(off.reviewedSearchSql('pe.id','$1'),'FALSE');
  assert.equal(off.reviewedHistorySql(primaryId),null);
  assert.equal(off.primaryAttendanceId(profileIds[1]),profileIds[1]);
  const req={professional:{professional_id:profileIds[1]}};
  let passed=false;await off.resolveAttendanceIdentity(req,{},()=>{passed=true;});
  assert.equal(passed,true);assert.equal(req.professional.professional_id,profileIds[1]);
});
