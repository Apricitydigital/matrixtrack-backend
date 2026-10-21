const {test}=require('node:test'),assert=require('node:assert/strict');
const {checkReportBudget,reportFilters,intersect,LIMITS}=require('../utils/attendanceReportBudget');
test('large reports fail explicitly instead of returning truncated data',()=>{
 assert.doesNotThrow(()=>checkReportBudget(16000,1000,1));
 assert.throws(()=>checkReportBudget(16000,1000,31),error=>error.status===413);
 assert.throws(()=>checkReportBudget(10,LIMITS.records+1,1),error=>error.status===413);
 assert.throws(()=>checkReportBudget(LIMITS.employees+1,1,1),error=>error.status===413);
 assert.doesNotThrow(()=>checkReportBudget(100,LIMITS.records,31));
});
test('report location selection only narrows permission scope',()=>{
 assert.deepEqual(reportFilters({cityId:'1',zoneId:'all',kothiIds:'10,20'}),{cityId:1,zoneId:null,sectorId:null,sites:[10,20]});
 assert.deepEqual(intersect([10],[10,20]),[10]);assert.deepEqual(intersect([],[10]),[]);
 assert.deepEqual(intersect(null,[10]),[10]);assert.equal(intersect(null,null),null);
 for(const input of [{cityId:'x'},{kothiIds:'0'},{zoneId:-1},{kothiIds:'all'}])assert.throws(()=>reportFilters(input),error=>error.status===400);
});
