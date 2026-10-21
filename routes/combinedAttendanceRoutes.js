const router=require('express').Router();
const pool=require('../config/db');
const authenticate=require('../middleware/authMiddleware');
const {attachCityScope,requireCityScope}=require('../middleware/cityScope');
const {attachKothiScope}=require('../middleware/kothiScope');
const {authorize,getPermissionCityFilter}=require('../middleware/permissionMiddleware');
const {dateRange,reportQuery,normalizeReport}=require('../utils/combinedAttendance');
const {checkReportBudget,reportFilters,intersect}=require('../utils/attendanceReportBudget');
const {getSignedS3Url}=require('../utils/s3SelfPunch');
router.use(authenticate,attachKothiScope,attachCityScope,requireCityScope(),authorize('attendance_reports','view'));
const selectType=(req,res,next)=>{
 req.reportEmployeeType=req.query.employeeType || req.body?.employeeType || 'all';
 if(!['all','regular','professional'].includes(req.reportEmployeeType))return res.status(400).json({error:'Invalid employee type.'});
 return req.reportEmployeeType==='regular'?next():authorize('professional-attendance','view')(req,res,next);
};
async function report(req,res) {
 let client;
 try {
  const range=dateRange({...req.body,...req.query});
  const filters=reportFilters({...req.body,...req.query});
  const days=(Date.parse(range.end)-Date.parse(range.start))/86400000+1;
  client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='15000ms'");
  await client.query("SET LOCAL lock_timeout='2000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='20000ms'");
  const rows=[];
  const deadline=Date.now()+60000;
  let recordCount=0;
  for(const kind of ['regular','professional']) {
   if(req.reportEmployeeType!=='all' && req.reportEmployeeType!==kind)continue;
   const query=reportQuery(kind,{...range,zoneId:filters.zoneId,sectorId:filters.sectorId,user:req.user,cityScope:req.cityScope,
    cities:intersect(getPermissionCityFilter(req,kind==='regular'?'attendance_reports':'professional-attendance','view'),filters.cityId===null?null:[filters.cityId]),
    sites:intersect(req.kothiScope?.all?null:req.kothiScope?.ids || [],filters.sites)});
   await client.query(`DECLARE attendance_report_cursor NO SCROLL CURSOR FOR ${query.sql}`,query.params);
   while(true){
    if(Date.now()>deadline)throw Object.assign(new Error('Report took too long. Choose a city/site or shorter date range.'),{status:413});
    const batch=(await client.query('FETCH FORWARD 100 FROM attendance_report_cursor')).rows;
    if(!batch.length)break;
    for(const row of batch){recordCount+=row.entries.length;checkReportBudget(rows.length+1,recordCount,days);rows.push(row);}
   }
   await client.query('CLOSE attendance_report_cursor');
  }
  await client.query('COMMIT');
  // Photo signing does not need a database connection. Return it to the pool
  // before processing what may be thousands of photos in a range report.
  client.release();client=null;
  const result=normalizeReport(rows);
  // Sign only actual punch photos, in bounded batches; no regular-image endpoint
  // receives a professional UUID. No biometric/profile data is returned here.
  const photos=result.records.filter(row=>row.employee_kind==='professional');
  for(let i=0;i<photos.length;i+=20)await Promise.all(photos.slice(i,i+20).map(async row=>{
   if(row.punch_in_image)row.punch_in_image_url=await getSignedS3Url(row.punch_in_image,900);
   if(row.punch_out_image)row.punch_out_image_url=await getSignedS3Url(row.punch_out_image,900);
  }));
  res.json(result);
 }catch(error){
  if(client){
   // A driver read timeout leaves the wire protocol in an uncertain state.
   // Destroy the connection rather than queueing a rollback behind that query.
   if(error.message==='Query read timeout'){client.release(error);client=null;}
   else try{await client.query('ROLLBACK');}catch(rollbackError){client.release(rollbackError);client=null;}
  }
  res.status(error.status || 500).json({error:error.status?error.message:'Unable to load combined attendance report.'});
 }
 finally{if(client)client.release();}
}
router.get('/',selectType,report);router.post('/',selectType,report);
module.exports=router;
