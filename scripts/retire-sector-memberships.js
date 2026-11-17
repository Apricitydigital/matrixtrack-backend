'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {retireSectorMemberships,restoreSectorMemberships}=require('../utils/sectorRetirement');
const {previewWardNames}=require('../utils/wardNameMigration');
const {previewWardNameCapacity,applyWardNameCapacity}=require('../utils/wardNameCapacity');
const {loadMigrationTarget,verifyConnectedTarget}=require('../utils/migrationTarget');
const {validateMigrationArguments}=require('../utils/migrationArguments');

async function main(args=process.argv.slice(2),{ClientType=Client,reportDirectory=path.resolve(__dirname,'../../outputs'),log=console.log,dmsCloudReader}={}) {
  validateMigrationArguments(args);
  if(args.includes('--help')){
    log('Usage: node scripts/retire-sector-memberships.js --expected-host=HOST --expected-database=DATABASE [--env-file=PATH] [--preview-names | --apply] [--rollback | --include-self-attendance-rename] [--archive-unused-canonical] [--review-inactive-dms] [--report=PATH]. DMS review uses AWS CLI credentials, verifies the owning account and absence of migrations, and keeps the exact audited trigger enabled. Non-preview DMS review requires --maintenance-confirmed. Apply requires --compatible-code-deployed --maintenance-confirmed and either --payroll-export-verified or explicit --accept-unverified-payroll-workbook. Default mode rehearses and rolls back.');
    return {mode:'HELP'};
  }
  const apply=args.includes('--apply'),preview=args.includes('--preview-names'),rollback=args.includes('--rollback');
  if(apply&&preview)throw Error('--preview-names is read-only and cannot be combined with --apply');
  if(rollback&&args.includes('--include-self-attendance-rename'))throw Error('Rollback does not reverse the Self Attendance table rename');
  if(args.includes('--archive-unused-canonical')&&(rollback||(!preview&&!args.includes('--include-self-attendance-rename'))))throw Error('--archive-unused-canonical requires the naming migration or a read-only preview');
  if(args.includes('--review-inactive-dms')&&!preview&&!args.includes('--maintenance-confirmed'))throw Error('--review-inactive-dms requires --maintenance-confirmed outside read-only preview');
  if(args.includes('--payroll-export-verified')&&args.includes('--accept-unverified-payroll-workbook'))throw Error('Choose verified payroll export or explicitly accepted unverified workbook risk, not both');
  const target=loadMigrationTarget(args);
  if(apply&&!args.includes('--compatible-code-deployed'))throw Error('Prepare the compatible backend/web/app before applying; rehearsal uses ROLLBACK.');
  if(apply&&!args.includes('--payroll-export-verified')&&!args.includes('--accept-unverified-payroll-workbook'))throw Error('Actual HR export/salary-sheet matching must be verified before apply; --payroll-export-verified is an operator acknowledgement, not an automated salary certification. An explicit operator decision may instead use --accept-unverified-payroll-workbook without claiming external verification.');
  fs.mkdirSync(reportDirectory,{recursive:true});
  const client=new ClientType({...target,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,
    statement_timeout:600000,application_name:preview?'ward-name-readonly-preview':'sector-retirement-'+(apply?'apply':'rehearsal')});
  let started=false,commitState='not_requested',operationFailed=false,dmsReview=null;
  try {
    await client.connect();await verifyConnectedTarget(client,target);
    await client.query(preview?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL READ COMMITTED');started=true;
    if(!preview)await client.query("SET LOCAL lock_timeout='5s'");
    if(!preview&&args.includes('--review-inactive-dms'))dmsReview=await require('../utils/dmsCutoverGuard').beginReviewedDmsCutover(client,target,{cloudReader:dmsCloudReader});
    let result;
    if(preview){
      result=await previewWardNames(client,{restore:rollback});
      result.capacityPlan=await previewWardNameCapacity(client,result);
      result.validAfterPlannedCapacity=result.capacityPlan.valid&&result.issues.every(issue=>issue.type==='name_too_long');
      result.ddlEventTriggers=(await client.query("SELECT evtname,evtenabled FROM pg_event_trigger WHERE evtenabled<>'D' ORDER BY evtname")).rows;
      if(args.includes('--review-inactive-dms'))result.dmsReview=await require('../utils/dmsCutoverGuard').reviewInactiveDms(client,target,{cloudReader:dmsCloudReader});
      if(args.includes('--archive-unused-canonical'))result.shadowSchema=await require('../utils/selfAttendanceShadowSchema').inspectShadowSchema(client);
      result.databasePreflightReady=result.validAfterPlannedCapacity&&(result.ddlEventTriggers.length===0||result.dmsReview?.migrationsAbsent===true);
      if(result.shadowSchema?.issues.length)result.databasePreflightReady=false;
      result.readyForApply=result.databasePreflightReady&&(args.includes('--payroll-export-verified')||args.includes('--accept-unverified-payroll-workbook'));
      result.externalPayrollContract='Actual HR export/salary-sheet matching not verified by this preview';
    }else if(rollback)result=await restoreSectorMemberships(client,message=>log(message),{verifyPayrollInputs:true,dmsReview});
    else{
      let shadowArchive=null;
      if(args.includes('--archive-unused-canonical')){
        await require('../utils/dmsCutoverGuard').assertEventTriggerSafety(client,dmsReview);
        shadowArchive=await require('../utils/selfAttendanceShadowSchema').archiveShadowSchema(client,{schema:'self_attendance_shadow_cutover'});
      }
      const naming=args.includes('--include-self-attendance-rename')?await require('../utils/selfAttendanceRenameMigration').renameSelfAttendance(client,{dmsReview}):null;
      const names=await previewWardNames(client);
      if(names.issues.some(issue=>issue.type!=='name_too_long'))require('../utils/wardNameMigration').assertValidNamePlan(names);
      const capacityPlan=await previewWardNameCapacity(client,names);
      const capacity=await applyWardNameCapacity(client,capacityPlan,{dmsReview});
      result=await retireSectorMemberships(client,message=>log(message),{requireCompleteSchema:true,combineWardNames:true,dmsReview});
      result.capacity=capacity;
      result.naming=naming;
      if(shadowArchive)result.shadowArchive=shadowArchive;
    }
    if(dmsReview){await require('../utils/dmsCutoverGuard').assertEventTriggerSafety(client,dmsReview);result.dmsReview={...dmsReview,enabledStatePreserved:true};}
    if(apply){
      commitState='requested';
      const committed=await client.query('COMMIT');started=false;
      if(committed.command!=='COMMIT'){commitState='rolled_back';throw Error('Database did not commit the migration');}
      commitState='committed';
    }else{await client.query('ROLLBACK');started=false;}
    const report={host:target.host,port:target.port,database:target.database,
      operation:rollback?'RESTORE':'RETIRE',mode:preview?'READ ONLY NAME PREVIEW':apply?'APPLIED':'REHEARSAL ROLLED BACK',
      payrollExportAcknowledged:args.includes('--payroll-export-verified'),includesNamingMigration:args.includes('--include-self-attendance-rename'),
      externalPayrollWorkbookRiskAccepted:args.includes('--accept-unverified-payroll-workbook'),
      timestamp:new Date().toISOString(),...result};
    const basename=preview?(rollback?'ward-names-restore-preview':'ward-names-preview'):
      (rollback?'sector-restoration-':'sector-retirement-')+(apply?'applied':'rehearsal');
    const requested=args.find(arg=>arg.startsWith('--report='))?.slice('--report='.length);
    let reportPath=requested?path.resolve(requested):path.join(reportDirectory,basename+'.json');
    if(fs.existsSync(reportPath))reportPath=reportPath.replace(/(?:\.json)?$/,`-${Date.now()}-${randomUUID().slice(0,8)}.json`);
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    log(JSON.stringify({mode:report.mode,changed:result.changed??0,combinedNames:result.combinedNames??0,
      restoredNames:result.restoredNames??0,valid:result.valid??true,nameIssues:result.issues?.length??0,
      capacityRequired:result.capacityPlan?.required??false,capacityRepairSupported:result.capacityPlan?.valid??null,
      payrollInputsVerified:result.payrollInputsVerified??false,
      protectedTables:result.protectedTables?.length??0,protectedDataUnchanged:result.protectedDataUnchanged??null,report:reportPath}));
    if(preview&&!result.databasePreflightReady)throw Error('Name preview saved with issues or DDL blockers; resolve them before rehearsal/apply');
    return {...report,reportPath};
  }catch(error){
    operationFailed=true;
    if(started&&commitState==='not_requested')await client.query('ROLLBACK').catch(()=>{});
    if(commitState==='committed')throw Error('Database changes committed; report save failed: '+error.message);
    if(commitState==='requested')throw Error('Commit outcome uncertain; verify the database before retrying: '+error.message);
    throw error;
  }finally{
    try{await client.end();}catch(error){
      if(!operationFailed)throw Error((commitState==='committed'?'Database changes committed; connection cleanup failed: ':'Database operation completed; connection cleanup failed: ')+error.message);
    }
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
