'use strict';
// Explicit maintenance command. Never imported by the server or a request handler.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {renameSelfAttendance}=require('../utils/selfAttendanceRenameMigration');
const {loadMigrationTarget,verifyConnectedTarget}=require('../utils/migrationTarget');
const {validateMigrationArguments}=require('../utils/migrationArguments');
async function main(args=process.argv.slice(2),{ClientType=Client,log=console.log}={}) {
  validateMigrationArguments(args,{flags:['--apply','--maintenance-confirmed','--payroll-export-verified','--help']});
  if(args.includes('--help')){log('Explicit naming migration: --expected-host=HOST --expected-database=DATABASE [--env-file=PATH] [--report=PATH]. Apply requires --apply --maintenance-confirmed --payroll-export-verified. Prefer the one-shot Ward cutover for the complete release.');return {mode:'HELP'};}
  const apply=args.includes('--apply');
  const target=loadMigrationTarget(args);
  if(apply&&!args.includes('--payroll-export-verified'))throw Error('Verify the actual HR export/salary-sheet contract before apply; --payroll-export-verified is required');
  const client=new ClientType({...target,ssl:{rejectUnauthorized:false},
    connectionTimeoutMillis:15000,statement_timeout:120000,query_timeout:130000,application_name:'self-attendance-rename'});
  let started=false,commitState='not_requested',failed=false;
  try {
    await client.connect();await verifyConnectedTarget(client,target);await client.query('BEGIN');started=true;
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const result=await renameSelfAttendance(client,{onStep:step=>log(step)});
    // Successful dry runs execute the complete migration and verification, then roll back.
    if(apply){commitState='requested';const commit=await client.query('COMMIT');started=false;
      if(commit.command!=='COMMIT'){commitState='rolled_back';throw Error('Database did not commit the naming migration');}commitState='committed';
    }else{await client.query('ROLLBACK');started=false;}
    const report={host:target.host,port:target.port,database:target.database,applied:apply,payrollExportAcknowledged:args.includes('--payroll-export-verified'),...result};
    const output=args.find(a=>a.startsWith('--report='))?.slice('--report='.length);
    if(output){
      let reportPath=path.resolve(output);
      // Keep the original cutover fingerprints when recording a readiness rerun.
      if(fs.existsSync(reportPath))reportPath=reportPath.replace(/(?:\.json)?$/,`-${Date.now()}-${randomUUID().slice(0,8)}.json`);
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});report.reportPath=reportPath;
    }
    log(JSON.stringify(report,null,2));return report;
  } catch(error) {
    failed=true;
    if(started&&commitState==='not_requested'&&error.message!=='Query read timeout')try{await client.query('ROLLBACK');}catch(_){}
    if(commitState==='committed')throw Error('Database changes committed; naming report failed: '+error.message);
    if(commitState==='requested')throw Error('Commit outcome uncertain; verify database before retrying: '+error.message);
    throw error;
  } finally {try{await client.end();}catch(error){if(!failed)throw Error((commitState==='committed'?'Database changes committed; ':'')+'connection cleanup failed: '+error.message);}}
}
if(require.main===module)main().catch(error=>{console.error('Self Attendance rename failed:',error.message);process.exitCode=1;});
module.exports={main};
