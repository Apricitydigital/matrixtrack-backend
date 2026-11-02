'use strict';
const {fullRowFingerprint}=require('./fullRowFingerprint');
const quote=value=>'"'+String(value).replace(/"/g,'""')+'"';
const literal=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const qualified=name=>'public.'+quote(name);
const allowedViews=new Set(['attendance_dashboard_view','ward_legacy_sector_links']);
const privilegeNames=new Set(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']);
const widenedType=(type,target)=>type==='text'||type==='character varying'?type:'character varying('+Math.max(Number(type.match(/\((\d+)\)/)?.[1]||0),target)+')';
const aclKey=rows=>JSON.stringify(rows.map(row=>({grantee:row.grantee,privilege_type:row.privilege_type,is_grantable:row.is_grantable})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
async function acl(db,oid){return (await db.query(`SELECT x.grantee::text AS grantee,CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS role,
 pg_get_userbyid(x.grantor) AS grantor,x.privilege_type,x.is_grantable FROM pg_class c,
 LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=$1 ORDER BY x.grantee,x.privilege_type`,[oid])).rows;}

async function previewWardNameCapacity(db,namePlan){
 const issues=[],targetLength=255;
 const base=(await db.query(`SELECT c.oid,c.relkind,c.relispartition,pg_get_userbyid(c.relowner) AS owner,
 current_user::text AS actor,format_type(a.atttypid,a.atttypmod) AS type,a.attnum
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.oid='public.wards'::regclass AND a.attname='ward_name' AND NOT a.attisdropped`)).rows[0];
 const required=Boolean(namePlan.requiredNameCapacity?.length),plan={required,valid:true,targetLength,issues,base,views:[],ddlEventTriggers:[]};
 if(!required)return plan;
 const max=Math.max(0,...namePlan.rows.map(row=>Array.from(row.proposed_name??'').length));
 if(max>targetLength)issues.push('Proposed names exceed the reviewed 255-character capacity');
 if(!base||base.relkind!=='r'||base.relispartition||base.owner!==base.actor||!/^character varying\(\d+\)$/.test(base.type))issues.push('Capacity migration requires the current owner of a non-partitioned VARCHAR Ward table');
 plan.ddlEventTriggers=(await db.query("SELECT evtname,evtenabled FROM pg_event_trigger WHERE evtenabled<>'D' ORDER BY evtname")).rows;
 const dependencies=(await db.query(`WITH RECURSIVE deps(oid) AS (
 SELECT DISTINCT r.ev_class FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid
 WHERE d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass AND d.refobjid='public.wards'::regclass AND d.refobjsubid=$1
 UNION SELECT r.ev_class FROM deps p JOIN pg_depend d ON d.refobjid=p.oid AND d.refclassid='pg_class'::regclass
 JOIN pg_rewrite r ON r.oid=d.objid AND d.classid='pg_rewrite'::regclass WHERE r.ev_class<>p.oid)
 SELECT c.oid,n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.reloptions,
 pg_get_viewdef(c.oid,true) AS definition,obj_description(c.oid,'pg_class') AS comment,pg_relation_is_updatable(c.oid,false) AS writable
 FROM deps d JOIN pg_class c ON c.oid=d.oid JOIN pg_namespace n ON n.oid=c.relnamespace ORDER BY c.relname`,[base.attnum])).rows;
 // Also rebuild the dashboard when only its explicit output casts need widening.
 const dashboard=(await db.query(`SELECT c.oid,n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.reloptions,
 pg_get_viewdef(c.oid,true) AS definition,obj_description(c.oid,'pg_class') AS comment,pg_relation_is_updatable(c.oid,false) AS writable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('public.attendance_dashboard_view')`)).rows;
 const all=[...new Map([...dependencies,...dashboard].map(view=>[String(view.oid),view])).values()];
 for(const view of all){
  if(view.nspname!=='public'||view.relkind!=='v'||!allowedViews.has(view.relname)){issues.push('Unreviewed dependent relation: '+view.nspname+'.'+view.relname);continue;}
  if(view.owner!==base.actor)issues.push('View owner must match migration actor: '+view.relname);
  if(Number(view.writable)!==0)issues.push('Writable views require a separate reviewed capacity plan: '+view.relname);
  if((view.reloptions||[]).some(option=>!/^security_(barrier|invoker)=(true|false)$/.test(option)))issues.push('Unreviewed view options: '+view.relname);
  if((await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid=$1 AND NOT tgisinternal UNION ALL SELECT 1 FROM pg_rewrite WHERE ev_class=$1 AND rulename<>'_RETURN' LIMIT 1",[view.oid])).rows.length)issues.push('Custom view rules/triggers require review: '+view.relname);
  view.columns=(await db.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,col_description(a.attrelid,a.attnum) AS comment,
   a.attacl IS NOT NULL AS column_acl,cn.nspname AS collation_schema,co.collname AS collation
   FROM pg_attribute a LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
   WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[view.oid])).rows;
  if(view.columns.some(c=>c.column_acl))issues.push('Column-level view grants require review: '+view.relname);
  if(view.columns.some(c=>['ward_name','kothi_name'].includes(c.name)&&! /^(text|character varying(?:\(\d+\))?)$/.test(c.type)))issues.push('Unreviewed name-column type: '+view.relname);
  if((await db.query("SELECT 1 FROM pg_seclabel WHERE classoid='pg_class'::regclass AND objoid=$1 LIMIT 1",[view.oid])).rows.length)issues.push('View security labels require review: '+view.relname);
  view.acl=await acl(db,view.oid);
  if(view.acl.some(entry=>entry.grantor!==base.actor||!privilegeNames.has(entry.privilege_type)))issues.push('Unreviewed grant provenance: '+view.relname);
  if(view.relname==='attendance_dashboard_view'){
   if(!['ward_id','ward_name','kothi_id','kothi_name'].every(name=>view.columns.some(c=>c.name===name)))issues.push('Dashboard lacks physical Ward aliases');
   const text=view.definition;
   if(/\bs\.sector_name\s+AS\s+ward_name\b/i.test(text))view.nameMode='sector';
   else if(/(?:SELECT|,)\s*w\.ward_name\s*(?:,|FROM)/i.test(text)||/\bw\.ward_name\s*(?:::\s*character varying(?:\(\d+\))?)?\s+AS\s+ward_name\b/i.test(text))view.nameMode='physical';
   else issues.push('Unreviewed dashboard Ward-name projection');
  }else view.nameMode='physical';
  view.dependencies=(await db.query(`SELECT DISTINCT c.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class c ON c.oid=d.refobjid
   WHERE r.ev_class=$1 AND d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass AND c.oid<>r.ev_class AND c.relkind='v' ORDER BY c.relname`,[view.oid])).rows.map(row=>row.relname);
  plan.views.push(view);
 }
 if((await db.query("SELECT 1 FROM pg_inherits WHERE inhparent='public.wards'::regclass OR inhrelid='public.wards'::regclass LIMIT 1")).rows.length)issues.push('Inherited Ward tables require a separate reviewed capacity plan');
 const order=[],pending=[...plan.views];
 while(pending.length){const i=pending.findIndex(view=>view.dependencies.every(dep=>!pending.some(other=>other.relname===dep)));
  if(i<0){issues.push('Dependent view cycle requires review');break;}order.push(pending.splice(i,1)[0].relname);}
 plan.createOrder=order;
 plan.valid=issues.length===0;
 return plan;
}

async function applyWardNameCapacity(db,plan){
 if(!plan.required)return {changed:false,targetLength:plan.targetLength};
 if(!plan.valid)throw Error('Ward capacity plan requires review: '+plan.issues.join('; '));
 await db.query("SET LOCAL lock_timeout='5s'");
 if((await db.query("SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D' LIMIT 1")).rows.length)throw Error('Review DDL event triggers before Ward capacity migration');
 if((await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid='public.wards'::regclass AND NOT tgisinternal AND tgenabled<>'D' LIMIT 1")).rows.length)throw Error('Review Ward triggers before capacity migration');
 if((await db.query("SELECT to_regclass('public.ward_name_capacity_backup') AS backup")).rows[0].backup)throw Error('Capacity backup already exists but schema is narrow; review instead of overwriting it');
 const {available,fingerprint}=require('./sectorRetirement');
 const tables=await available(db);
 for(const required of ['employee','attendance','self_attendance_employees','self_punch_requests','self_attendance_records'])if(!tables.includes(required))throw Error('Run the Self Attendance naming migration first; missing '+required);
 await db.query(`LOCK TABLE ${[...new Set([...tables,'wards'])].sort().map(qualified).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
 for(const view of plan.views)await db.query('LOCK TABLE '+qualified(view.relname)+' IN ACCESS EXCLUSIVE MODE');
 const fresh=await previewWardNameCapacity(db,await require('./wardNameMigration').previewWardNames(db));
 if(JSON.stringify(fresh)!==JSON.stringify(plan))throw Error('Ward capacity metadata changed since preview; run a fresh preview');
 const before=await fingerprint(db,tables,()=>{},{fullAttendance:true}),viewBefore={};
 for(const view of plan.views)viewBefore[view.relname]=await fullRowFingerprint(db,view.relname);
 await db.query(`CREATE TABLE ward_name_capacity_backup(id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),original_type TEXT NOT NULL,
 target_type TEXT NOT NULL,views JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
 await db.query('INSERT INTO ward_name_capacity_backup(id,original_type,target_type,views) VALUES(TRUE,$1,$2,$3::jsonb)',[plan.base.type,'character varying('+plan.targetLength+')',JSON.stringify(plan.views)]);
 for(const name of [...plan.createOrder].reverse())await db.query('DROP VIEW '+qualified(name)+' RESTRICT');
 const originalLength=Number(plan.base.type.match(/\((\d+)\)/)[1]);
 if(originalLength<plan.targetLength)await db.query('ALTER TABLE public.wards ALTER COLUMN ward_name TYPE character varying('+plan.targetLength+')');
 for(const name of plan.createOrder){
  const view=plan.views.find(item=>item.relname===name),id=name==='attendance_dashboard_view'?'kothi_id':'ward_id';
  const target=Math.max(originalLength,plan.targetLength);
  const projections=view.columns.map(column=>{
   let expression='q.'+quote(column.name);
   if(column.name==='kothi_name'||(column.name==='ward_name'&&view.nameMode==='physical'))expression='capacity_ward.ward_name';
   if(column.name==='ward_name'||column.name==='kothi_name')expression+='::'+widenedType(column.type,target);
   if(column.collation)expression+=' COLLATE '+quote(column.collation_schema)+'.'+quote(column.collation);
   return expression+' AS '+quote(column.name);
  });
  const options=(view.reloptions||[]).length?' WITH ('+view.reloptions.join(',')+')':'';
  await db.query('CREATE VIEW '+qualified(name)+options+' AS SELECT '+projections.join(',')+' FROM ('+view.definition.replace(/;\s*$/,'')+') q LEFT JOIN public.wards capacity_ward ON capacity_ward.ward_id=q.'+quote(id));
  // Default privileges can differ from the old view. Restore the exact old ACL,
  // including PUBLIC and grant options; never widen app access implicitly.
  const oid=(await db.query('SELECT $1::regclass::oid AS oid',['public.'+name])).rows[0].oid;
  for(const grant of [...new Map((await acl(db,oid)).map(entry=>[entry.grantee,entry])).values()])await db.query('REVOKE ALL PRIVILEGES ON '+qualified(name)+' FROM '+(grant.grantee==='0'?'PUBLIC':quote(grant.role)));
  for(const grant of view.acl)await db.query('GRANT '+grant.privilege_type+' ON '+qualified(name)+' TO '+(grant.grantee==='0'?'PUBLIC':quote(grant.role))+(grant.is_grantable?' WITH GRANT OPTION':''));
  await db.query('COMMENT ON VIEW '+qualified(name)+' IS '+literal(view.comment));
  for(const column of view.columns)if(column.comment!=null)await db.query('COMMENT ON COLUMN '+qualified(name)+'.'+quote(column.name)+' IS '+literal(column.comment));
  if(aclKey(await acl(db,oid))!==aclKey(view.acl))throw Error('View access changed during capacity migration: '+name);
  const columns=(await db.query('SELECT attname AS name,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped ORDER BY attnum',[oid])).rows;
  const expected=view.columns.map(column=>({name:column.name,type:['ward_name','kothi_name'].includes(column.name)?widenedType(column.type,target):column.type}));
  if(JSON.stringify(columns)!==JSON.stringify(expected))throw Error('Unexpected view column contract change: '+name);
 }
 const after=await fingerprint(db,tables,()=>{},{fullAttendance:true}),viewAfter={};
 for(const view of plan.views)viewAfter[view.relname]=await fullRowFingerprint(db,view.relname);
 if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(viewBefore)!==JSON.stringify(viewAfter))throw Error('Attendance/business/view contents changed during capacity migration; roll back');
 return {changed:true,targetLength:Math.max(originalLength,plan.targetLength),views:plan.createOrder,before,after,viewBefore,viewAfter,protectedDataUnchanged:true};
}
module.exports={previewWardNameCapacity,applyWardNameCapacity};
