'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {retireSectorMemberships,restoreSectorMemberships}=require('../utils/sectorRetirement');
const {previewWardNames}=require('../utils/wardNameMigration');
const {previewWardNameCapacity,applyWardNameCapacity}=require('../utils/wardNameCapacity');
const {loadMigrationTarget,verifyConnectedTarget}=require('../utils/migrationTarget');
const {validateMigrationArguments}=require('../utils/migrationArguments');

async function main(args=process.argv.slice(2),{ClientType=Client,reportDirectory=path.resolve(__dirname,'../../outputs'),log=console.log}={}) {
  validateMigrationArguments(args);
  if(args.includes('--help')){
    log('Usage: node scripts/retire-sector-memberships.js --expected-host=HOST --expected-database=DATABASE [--env-file=PATH] [--preview-names | --apply] [--rollback | --include-self-attendance-rename] [--report=PATH]. Apply also requires --compatible-code-deployed --maintenance-confirmed --payroll-export-verified after actual HR-sheet verification. Default mode rehearses and rolls back.');
    return {mode:'HELP'};
  }
  const apply=args.includes('--apply'),preview=args.includes('--preview-names'),rollback=args.includes('--rollback');
  if(apply&&preview)throw Error('--preview-names is read-only and cannot be combined with --apply');
  if(rollback&&args.includes('--include-self-attendance-rename'))throw Error('Rollback does not reverse the Self Attendance table rename');
  const target=loadMigrationTarget(args);
  if(apply&&!args.includes('--compatible-code-deployed'))throw Error('Prepare the compatible backend/web/app before applying; rehearsal uses ROLLBACK.');
  if(apply&&!args.includes('--payroll-export-verified'))throw Error('Actual HR export/salary-sheet matching must be verified before apply; --payroll-export-verified is an operator acknowledgement, not an automated salary certification');
  fs.mkdirSync(reportDirectory,{recursive:true});
  const client=new ClientType({...target,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,
    statement_timeout:120000,application_name:preview?'ward-name-readonly-preview':'sector-retirement-'+(apply?'apply':'rehearsal')});
  let started=false,commitState='not_requested',operationFailed=false;
  try {
    await client.connect();await verifyConnectedTarget(client,target);
    await client.query(preview?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL READ COMMITTED');started=true;
    if(!preview)await client.query("SET LOCAL lock_timeout='5s'");
    let result;
    if(preview){
      result=await previewWardNames(client,{restore:rollback});
      result.capacityPlan=await previewWardNameCapacity(client,result);
      result.validAfterPlannedCapacity=result.capacityPlan.valid&&result.issues.every(issue=>issue.type==='name_too_long');
      result.ddlEventTriggers=(await client.query("SELECT evtname,evtenabled FROM pg_event_trigger WHERE evtenabled<>'D' ORDER BY evtname")).rows;
      result.databasePreflightReady=result.validAfterPlannedCapacity&&result.ddlEventTriggers.length===0;
      result.readyForApply=result.databasePreflightReady&&args.includes('--payroll-export-verified');
      result.externalPayrollContract='Actual HR export/salary-sheet matching not verified by this preview';
    }else if(rollback)result=await restoreSectorMemberships(client,message=>log(message),{verifyPayrollInputs:true});
    else{
      const naming=args.includes('--include-self-attendance-rename')?await require('../utils/selfAttendanceRenameMigration').renameSelfAttendance(client):null;
      const names=await previewWardNames(client);
      if(names.issues.some(issue=>issue.type!=='name_too_long'))require('../utils/wardNameMigration').assertValidNamePlan(names);
      const capacityPlan=await previewWardNameCapacity(client,names);
      const capacity=await applyWardNameCapacity(client,capacityPlan);
      result=await retireSectorMemberships(client,message=>log(message),{requireCompleteSchema:true,combineWardNames:true});
      result.capacity=capacity;
      result.naming=naming;
    }
    if(apply){
      commitState='requested';
      const committed=await client.query('COMMIT');started=false;
      if(committed.command!=='COMMIT'){commitState='rolled_back';throw Error('Database did not commit the migration');}
      commitState='committed';
    }else{await client.query('ROLLBACK');started=false;}
    const report={host:target.host,port:target.port,database:target.database,
      operation:rollback?'RESTORE':'RETIRE',mode:preview?'READ ONLY NAME PREVIEW':apply?'APPLIED':'REHEARSAL ROLLED BACK',
      payrollExportAcknowledged:args.includes('--payroll-export-verified'),includesNamingMigration:args.includes('--include-self-attendance-rename'),
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
