'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const run=promisify(execFile);
const currentReview=Symbol('current DMS topology review');
const auditedBody=`declare _qry text; BEGIN if (tg_tag='CREATE TABLE' or tg_tag='ALTER TABLE' or tg_tag='DROP TABLE' or tg_tag = 'CREATE TABLE AS') then SELECT current_query() into _qry; insert into public.awsdms_ddl_audit values ( default,current_timestamp,current_user,cast(TXID_CURRENT()as varchar(16)),tg_tag,0,'',current_schema,_qry ); delete from public.awsdms_ddl_audit; end if; END;`;
const bodyHash=value=>createHash('sha256').update(String(value).replace(/\s+/g,' ').trim()).digest('hex');
async function readCloudTopology({profile=process.env.AWS_PROFILE,region=process.env.AWS_REGION||'ap-south-1'}={}){
 if(profile&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile))throw Error('Invalid AWS profile');
 if(!/^[a-z]{2}-[a-z]+-\d$/.test(region))throw Error('Invalid AWS region');
 const common=['--region',region,'--output','json','--no-cli-pager','--cli-connect-timeout','10','--cli-read-timeout','20'];
 if(profile)common.push('--profile',profile);
 const query=async(service,operation,projection)=>{
  const {stdout}=await run(process.platform==='win32'?'aws.exe':'aws',[service,operation,...common,'--query',projection],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
  return JSON.parse(stdout);
 };
 const [identity,instances,endpoints,tasks,replications,dataMigrations]=await Promise.all([
  query('sts','get-caller-identity','{Account:Account}'),
  query('rds','describe-db-instances','DBInstances[].{Host:Endpoint.Address,Port:Endpoint.Port,Arn:DBInstanceArn,Engine:Engine,Status:DBInstanceStatus}'),
  query('dms','describe-endpoints','Endpoints[].{Id:EndpointIdentifier,Host:ServerName,Database:DatabaseName,Type:EndpointType}'),
  query('dms','describe-replication-tasks','ReplicationTasks[].{Id:ReplicationTaskIdentifier,Status:Status}'),
  query('dms','describe-replications','Replications[].{Arn:ReplicationConfigArn,Status:Status}'),
  query('dms','describe-data-migrations','DataMigrations[].{Id:DataMigrationIdentifier,Status:Status}')
 ]);
 return {timestamp:new Date().toISOString(),region,profile:profile||'default credential chain',identity,instances,endpoints,tasks,replications,dataMigrations};
}
async function reviewInactiveDms(client,target,{cloudReader=readCloudTopology}={}){
 const cloud=await cloudReader();
 const account=cloud.identity?.Account;
 if(!/^\d{12}$/.test(account||''))throw Error('AWS account identity missing from DMS review');
 const instance=cloud.instances?.find(i=>i.Host===target.host&&Number(i.Port)===Number(target.port));
 if(!instance||instance.Engine!=='postgres'||instance.Status!=='available'||String(instance.Arn).split(':')[4]!==account||String(instance.Arn).split(':')[3]!==cloud.region)
  throw Error('AWS review does not identify the exact available production RDS instance');
 if(!Array.isArray(cloud.endpoints)||!Array.isArray(cloud.tasks)||!Array.isArray(cloud.replications)||!Array.isArray(cloud.dataMigrations))throw Error('Incomplete DMS topology review');
 // Deliberately narrow support: an account/region with any migration resource
 // needs its own review, even when a task currently reports stopped.
 if(cloud.tasks.length||cloud.replications.length||cloud.dataMigrations.length)throw Error('DMS migration resources exist; review their DDL contract before this cutover');
 const triggers=(await client.query(`SELECT e.evtname,e.evtenabled,e.evtevent,e.evttags,n.nspname AS function_schema,
  p.proname,p.prosrc,p.prosecdef,l.lanname FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid
  JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE e.evtenabled<>'D' ORDER BY e.evtname`)).rows;
 if(triggers.length!==1)throw Error('Expected exactly the reviewed legacy DMS event trigger');
 const trigger=triggers[0];
 if(trigger.evtname!=='awsdms_intercept_ddl'||trigger.evtevent!=='ddl_command_end'||trigger.evttags!==null||trigger.function_schema!=='public'||trigger.proname!=='awsdms_intercept_ddl'||trigger.lanname!=='plpgsql'||!trigger.prosecdef||!['O','A','R'].includes(trigger.evtenabled)||bodyHash(trigger.prosrc)!==bodyHash(auditedBody))
  throw Error('DMS trigger definition differs from the reviewed AWS audit-only function');
 if((await client.query('SELECT slot_name FROM pg_replication_slots')).rows.length||(await client.query('SELECT pid FROM pg_stat_replication')).rows.length)
  throw Error('Database replication is configured; review it before cutover');
 if((await client.query('SELECT count(*)::text AS n FROM public.awsdms_ddl_audit')).rows[0].n!=='0')throw Error('Existing DMS audit rows require review before DDL');
 const review={timestamp:new Date().toISOString(),region:cloud.region,account,instanceArn:instance.Arn,host:target.host,database:target.database,profile:cloud.profile,migrationsAbsent:true,classicTasks:0,serverlessReplications:0,homogeneousMigrations:0,endpoints:cloud.endpoints,trigger:{name:trigger.evtname,originalState:trigger.evtenabled,functionSha256:bodyHash(trigger.prosrc)},replicationSlots:0,triggerLeftEnabled:true};
 Object.defineProperty(review,currentReview,{value:true});return review;
}
async function assertEventTriggerSafety(client,review){
 const enabled=(await client.query("SELECT evtname,evtenabled FROM pg_event_trigger WHERE evtenabled<>'D' ORDER BY evtname")).rows;
 if(!enabled.length&&!review)return;
 if(!review?.[currentReview]||!review.migrationsAbsent||!review.triggerLeftEnabled)throw Error('Review enabled database event triggers before migration; protected rows must not be modified by DDL.');
 if(enabled.length!==1||enabled[0].evtname!==review.trigger.name||enabled[0].evtenabled!==review.trigger.originalState)throw Error('Reviewed DMS trigger state changed; roll back');
 const current=(await client.query("SELECT p.prosrc,current_database() AS database FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid WHERE e.evtname='awsdms_intercept_ddl'")).rows[0];
 if(!current||current.database!==review.database||bodyHash(current.prosrc)!==review.trigger.functionSha256)throw Error('Reviewed DMS definition/database changed; roll back');
 if((await client.query('SELECT slot_name FROM pg_replication_slots')).rows.length||(await client.query('SELECT pid FROM pg_stat_replication')).rows.length)throw Error('Replication state changed after DMS review; roll back');
 if((await client.query('SELECT count(*)::text AS n FROM public.awsdms_ddl_audit')).rows[0].n!=='0')throw Error('DMS audit table is not empty after DDL; roll back');
}
async function beginReviewedDmsCutover(client,target,options){
 await client.query('SAVEPOINT matrixtrack_dms_transaction_guard');await client.query('RELEASE SAVEPOINT matrixtrack_dms_transaction_guard');
 const review=await reviewInactiveDms(client,target,options);
 const writers=(await client.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()")).rows;
 if(writers.length)throw Error('Stop every database client/writer before the reviewed DMS cutover');
 await assertEventTriggerSafety(client,review);return review;
}
module.exports={readCloudTopology,reviewInactiveDms,beginReviewedDmsCutover,assertEventTriggerSafety,auditedBody};
