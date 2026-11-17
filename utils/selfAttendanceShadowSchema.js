'use strict';
const {renameIdentifier}=require('./selfAttendanceNaming');
const quote=value=>'"'+String(value).replace(/"/g,'""')+'"';
const singletonSettings=new Set(['self_attendance_feature_settings','self_attendance_punch_settings']);
async function looseReferences(client,parent,column,known){
 const columns=(await client.query(`SELECT n.nspname AS schema,c.relname AS table,a.attname AS column,1 AS width
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE c.relkind IN ('r','p') AND NOT a.attisdropped AND a.attnum>0 AND a.attname=$1
  AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
  AND NOT(n.nspname='public' AND c.relname=$2) ORDER BY n.nspname,c.relname`,[column,parent])).rows;
 return columns.filter(c=>!known.some(r=>r.schema===c.schema&&r.table===c.table&&r.column===c.column));
}
async function fingerprint(client,schema,table){
 return (await client.query(`SELECT count(*)::text AS count,
  md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS digest FROM
  (SELECT md5(to_jsonb(t)::text) AS h FROM ${quote(schema)}.${quote(table)} t) rows`)).rows[0];
}
async function inspectShadowSchema(client){
 const relations=(await client.query(`SELECT c.oid,c.relname,c.relkind FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  AND c.relkind IN ('r','p','S','v','m','i','I') ORDER BY c.relname`)).rows;
 const tables=[];
 for(const legacy of relations.filter(r=>['r','p'].includes(r.relkind)&&/professional/i.test(r.relname))){
  const canonical=renameIdentifier(legacy.relname);
  const target=relations.find(r=>r.relname===canonical);
  if(target){
   if(target.relkind!=='r')throw Error('Only ordinary shadow tables are supported: '+canonical);
   tables.push({legacy:legacy.relname,canonical,oid:target.oid,...await fingerprint(client,'public',canonical)});
  }
 }
 const names=tables.map(t=>t.canonical),issues=[];
 for(const t of tables)if(t.count!=='0'&&!(singletonSettings.has(t.canonical)&&t.count==='1'))
  issues.push({type:'nonempty_shadow_data',table:t.canonical,count:t.count});
 const foreignKeys=(await client.query(`SELECT cn.nspname AS "childSchema",ch.relname AS child,pa.relname AS parent,con.conname
  FROM pg_constraint con JOIN pg_class ch ON ch.oid=con.conrelid
  JOIN pg_namespace cn ON cn.oid=ch.relnamespace
  JOIN pg_class pa ON pa.oid=con.confrelid JOIN pg_namespace n ON n.oid=pa.relnamespace
  WHERE con.contype='f' AND n.nspname='public' AND pa.relname=ANY($1::text[])
  ORDER BY ch.relname,pa.relname,con.conname`,[names])).rows;
 for(const fk of foreignKeys)if(fk.childSchema!=='public'||!names.includes(fk.child))issues.push({type:'external_foreign_key',...fk});
 const views=(await client.query(`SELECT DISTINCT n.nspname AS schema,v.relname AS view,t.relname AS target
  FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class v ON v.oid=r.ev_class
  JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace n ON n.oid=v.relnamespace
  WHERE d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass
  AND t.relname=ANY($1::text[]) AND v.oid<>t.oid
  ORDER BY v.relname,t.relname`,[names])).rows;
 for(const view of views)issues.push({type:'external_view',...view});
 const allFunctions=(await client.query(`SELECT p.oid,p.proname,p.prokind,
  pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.prokind IN ('f','p') ORDER BY p.proname,p.oid`)).rows;
 const functions=[];
 for(const legacy of allFunctions.filter(f=>/professional/i.test(f.proname))){
  const target=allFunctions.find(f=>f.proname===renameIdentifier(legacy.proname)&&f.args===legacy.args&&f.prokind===legacy.prokind);
  if(target)functions.push({...target,legacy:legacy.proname});
 }
 if(functions.length){
  const triggers=(await client.query(`SELECT n.nspname AS schema,c.relname AS table,t.tgname,p.proname AS function
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal
   AND t.tgfoid=ANY($1::oid[]) ORDER BY c.relname,t.tgname`,[functions.map(f=>f.oid)])).rows;
  for(const trigger of triggers)if(trigger.schema!=='public'||!names.includes(trigger.table))issues.push({type:'external_shadow_function_trigger',...trigger});
  const views=(await client.query(`SELECT DISTINCT n.nspname AS schema,v.relname AS view,p.proname AS function
   FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class v ON v.oid=r.ev_class
   JOIN pg_namespace n ON n.oid=v.relnamespace JOIN pg_proc p ON p.oid=d.refobjid
   WHERE d.classid='pg_rewrite'::regclass AND d.refclassid='pg_proc'::regclass
   AND p.oid=ANY($1::oid[]) ORDER BY v.relname,p.proname`,[functions.map(f=>f.oid)])).rows;
  for(const view of views)issues.push({type:'external_shadow_function_view',...view});
  const callers=(await client.query(`SELECT n.nspname AS schema,c.proname AS caller,p.proname AS function
   FROM pg_depend d JOIN pg_proc c ON c.oid=d.objid JOIN pg_namespace n ON n.oid=c.pronamespace
   JOIN pg_proc p ON p.oid=d.refobjid WHERE d.classid='pg_proc'::regclass AND d.refclassid='pg_proc'::regclass
   AND p.oid=ANY($1::oid[]) AND NOT c.oid=ANY($1::oid[]) ORDER BY n.nspname,c.proname,p.proname`,[functions.map(f=>f.oid)])).rows;
  for(const caller of callers)issues.push({type:'external_shadow_function_caller',...caller});
 }
 const permissions=[];
 if(relations.some(r=>r.relname==='permissions')){
  const rows=(await client.query('SELECT to_jsonb(p) AS row FROM public.permissions p ORDER BY id')).rows.map(r=>r.row);
  const references=(await client.query(`SELECT n.nspname AS schema,c.relname AS table,a.attname AS column,
   cardinality(f.conkey) AS width FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=f.conkey[1]
   WHERE f.contype='f' AND f.confrelid='public.permissions'::regclass ORDER BY n.nspname,c.relname,a.attname`)).rows;
  references.push(...await looseReferences(client,'permissions','permission_id',references));
  for(const legacy of rows.filter(p=>/professional/i.test(p.module))){
   const target=rows.find(p=>p.id!==legacy.id&&p.module===renameIdentifier(legacy.module)&&p.action===legacy.action);
   if(!target)continue;
   for(const ref of references){
    if(ref.width!==1){issues.push({type:'unsupported_permission_reference',...ref});continue;}
    const count=(await client.query(`SELECT count(*)::text AS n FROM ${quote(ref.schema)}.${quote(ref.table)} WHERE ${quote(ref.column)}=$1`,[target.id])).rows[0].n;
    if(count!=='0')issues.push({type:'assigned_shadow_permission',id:target.id,reference:ref.table,count});
   }
   permissions.push({legacyId:legacy.id,shadow:target});
  }
 }
 const departments=[];
 if(relations.some(r=>r.relname==='department')){
  const rows=(await client.query('SELECT to_jsonb(d) AS row FROM public.department d ORDER BY department_id')).rows.map(r=>r.row);
  const legacy=rows.find(d=>String(d.department_name).trim().toLowerCase()==='professional');
  const target=legacy&&rows.find(d=>d.department_id!==legacy.department_id&&d.department_name==='Self Attendance');
  if(target){
   const designations=relations.some(r=>r.relname==='designation')?(await client.query('SELECT to_jsonb(d) AS row FROM designation d WHERE department_id=$1 ORDER BY designation_id',[target.department_id])).rows.map(r=>r.row):[];
   const legacyDesignations=relations.some(r=>r.relname==='designation')?(await client.query('SELECT designation_name FROM designation WHERE department_id=$1',[legacy.department_id])).rows.map(r=>r.designation_name):[];
   const designationReferences=designations.length?(await client.query(`SELECT n.nspname AS schema,c.relname AS table,a.attname AS column,cardinality(f.conkey) AS width
    FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=f.conkey[1]
    WHERE f.contype='f' AND f.confrelid='public.designation'::regclass ORDER BY n.nspname,c.relname,a.attname`)).rows:[];
   if(designations.length)designationReferences.push(...await looseReferences(client,'designation','designation_id',designationReferences));
   for(const d of designations){
    if(!legacyDesignations.includes(d.designation_name))issues.push({type:'unmatched_shadow_designation',id:d.designation_id});
    for(const ref of designationReferences){
     if(ref.width!==1){issues.push({type:'unsupported_designation_reference',...ref});continue;}
     const count=(await client.query(`SELECT count(*)::text AS n FROM ${quote(ref.schema)}.${quote(ref.table)} WHERE ${quote(ref.column)}=$1`,[d.designation_id])).rows[0].n;
     if(count!=='0')issues.push({type:'assigned_shadow_designation',id:d.designation_id,reference:ref.table,count});
    }
   }
   const refs=(await client.query(`SELECT n.nspname AS schema,c.relname AS table,a.attname AS column,cardinality(f.conkey) AS width
    FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=f.conkey[1]
    WHERE f.contype='f' AND f.confrelid='public.department'::regclass ORDER BY n.nspname,c.relname,a.attname`)).rows;
   refs.push(...await looseReferences(client,'department','department_id',refs));
   for(const ref of refs){
    if(ref.width!==1){issues.push({type:'unsupported_department_reference',...ref});continue;}
    const count=(await client.query(`SELECT count(*)::text AS n FROM ${quote(ref.schema)}.${quote(ref.table)} WHERE ${quote(ref.column)}=$1`,[target.department_id])).rows[0].n;
    if(count!=='0'&&!(ref.schema==='public'&&ref.column==='department_id'&&['department_cities','designation'].includes(ref.table)))
     issues.push({type:'assigned_shadow_department',id:target.department_id,reference:ref.table,count});
   }
   const cityLinks=relations.some(r=>r.relname==='department_cities')?(await client.query('SELECT to_jsonb(d) AS row FROM department_cities d WHERE department_id=$1 ORDER BY to_jsonb(d)::text',[target.department_id])).rows.map(r=>r.row):[];
   departments.push({legacyId:legacy.department_id,shadow:target,cityLinks,designations});
  }
 }
 return {tables,functions,permissions,departments,issues};
}
// Caller owns BEGIN/ROLLBACK/COMMIT. Archive preserves every shadow row and OID;
// actual employee/punch data must still live solely in the legacy tables.
async function archiveShadowSchema(client,{schema,expectedPlan}={}){
 await client.query('SAVEPOINT matrixtrack_shadow_transaction_guard');
 await client.query('RELEASE SAVEPOINT matrixtrack_shadow_transaction_guard');
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema||''))throw Error('Invalid private archive schema');
 if((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows.length)
  throw Error('Archive schema already exists; inspect the previous operation');
 const initial=await inspectShadowSchema(client);
 if(initial.issues.length)throw Object.assign(Error('Shadow schema requires reconciliation before cutover'),{details:initial.issues});
 if(expectedPlan&&JSON.stringify(initial)!==JSON.stringify(expectedPlan))throw Error('Shadow schema changed after preview');
 if(!initial.tables.length&&!initial.permissions.length&&!initial.departments.length)return {archived:false,tables:[],functions:[],permissions:[],departments:[]};
 await client.query('SET LOCAL lock_timeout=\'5s\'');
 if(initial.tables.length)await client.query('LOCK TABLE '+initial.tables.map(t=>'public.'+quote(t.canonical)).join(',')+' IN ACCESS EXCLUSIVE MODE');
 if(initial.permissions.length){
  await client.query('LOCK TABLE public.permissions IN ACCESS EXCLUSIVE MODE');
  const children=(await client.query(`SELECT DISTINCT conrelid::regclass::text AS name FROM pg_constraint WHERE contype='f' AND confrelid='public.permissions'::regclass ORDER BY name`)).rows;
  for(const child of children)await client.query('LOCK TABLE '+child.name+' IN SHARE ROW EXCLUSIVE MODE');
 }
 if(initial.departments.length){
  await client.query('LOCK TABLE public.department IN ACCESS EXCLUSIVE MODE');
  const children=(await client.query(`SELECT DISTINCT conrelid::regclass::text AS name FROM pg_constraint WHERE contype='f' AND confrelid='public.department'::regclass ORDER BY name`)).rows;
  for(const child of children)await client.query('LOCK TABLE '+child.name+' IN SHARE ROW EXCLUSIVE MODE');
  const designationChildren=(await client.query(`SELECT DISTINCT conrelid::regclass::text AS name FROM pg_constraint WHERE contype='f' AND confrelid=to_regclass('public.designation') ORDER BY name`)).rows;
  for(const child of designationChildren)await client.query('LOCK TABLE '+child.name+' IN SHARE ROW EXCLUSIVE MODE');
 }
 const related=[];
 if(initial.permissions.length)related.push(...await looseReferences(client,'permissions','permission_id',[]));
 if(initial.departments.length){
  related.push(...await looseReferences(client,'department','department_id',[]));
  related.push(...await looseReferences(client,'designation','designation_id',[]));
 }
 for(const table of [...new Set(related.map(r=>quote(r.schema)+'.'+quote(r.table)))].sort())
  await client.query('LOCK TABLE '+table+' IN SHARE ROW EXCLUSIVE MODE');
 const locked=await inspectShadowSchema(client);
 if(JSON.stringify(initial)!==JSON.stringify(locked))throw Error('Shadow schema changed while acquiring locks');
 await client.query('CREATE SCHEMA '+quote(schema));
 await client.query('REVOKE ALL ON SCHEMA '+quote(schema)+' FROM PUBLIC');
 for(const fn of locked.functions)await client.query(`ALTER ${fn.prokind==='p'?'PROCEDURE':'FUNCTION'} public.${quote(fn.proname)}(${fn.args}) SET SCHEMA ${quote(schema)}`);
 for(const t of locked.tables)await client.query(`ALTER TABLE public.${quote(t.canonical)} SET SCHEMA ${quote(schema)}`);
 for(const t of locked.tables){
  const after=await fingerprint(client,schema,t.canonical);
  if(after.count!==t.count||after.digest!==t.digest)throw Error('Archived shadow data changed: '+t.canonical);
  const oid=(await client.query('SELECT to_regclass($1)::oid AS oid',[quote(schema)+'.'+quote(t.canonical)])).rows[0].oid;
  if(String(oid)!==String(t.oid))throw Error('Archived shadow table identity changed: '+t.canonical);
 }
 if(locked.permissions.length){
  await client.query(`CREATE TABLE ${quote(schema)}.permissions_shadow (LIKE public.permissions INCLUDING ALL)`);
  const ids=locked.permissions.map(p=>p.shadow.id);
  const copied=await client.query(`INSERT INTO ${quote(schema)}.permissions_shadow SELECT * FROM public.permissions WHERE id=ANY($1::int[])`,[ids]);
  if(copied.rowCount!==ids.length)throw Error('Shadow permission backup count mismatch');
  const saved=(await client.query(`SELECT to_jsonb(p) AS row FROM ${quote(schema)}.permissions_shadow p ORDER BY id`)).rows.map(r=>r.row);
  const expected=locked.permissions.map(p=>p.shadow).sort((a,b)=>a.id-b.id);
  if(JSON.stringify(saved)!==JSON.stringify(expected))throw Error('Shadow permission backup differs');
  const removed=await client.query('DELETE FROM public.permissions WHERE id=ANY($1::int[])',[ids]);
  if(removed.rowCount!==ids.length)throw Error('Shadow permission removal count mismatch');
 }
 if(locked.departments.length){
  const designations=locked.departments.flatMap(d=>d.designations).sort((a,b)=>a.designation_id-b.designation_id);
  if(designations.length){
   await client.query(`CREATE TABLE ${quote(schema)}.designation_shadow (LIKE public.designation INCLUDING ALL)`);
   const ids=designations.map(d=>d.designation_id);
   await client.query(`INSERT INTO ${quote(schema)}.designation_shadow SELECT * FROM designation WHERE designation_id=ANY($1::int[])`,[ids]);
   const saved=(await client.query(`SELECT to_jsonb(d) AS row FROM ${quote(schema)}.designation_shadow d ORDER BY designation_id`)).rows.map(r=>r.row);
   if(JSON.stringify(saved)!==JSON.stringify(designations))throw Error('Shadow designation backup differs');
   const removed=await client.query('DELETE FROM designation WHERE designation_id=ANY($1::int[])',[ids]);
   if(removed.rowCount!==ids.length)throw Error('Shadow designation removal count mismatch');
  }
  await client.query(`CREATE TABLE ${quote(schema)}.department_shadow (LIKE public.department INCLUDING ALL)`);
  const ids=locked.departments.map(d=>d.shadow.department_id);
  await client.query(`INSERT INTO ${quote(schema)}.department_shadow SELECT * FROM department WHERE department_id=ANY($1::int[])`,[ids]);
  const saved=(await client.query(`SELECT to_jsonb(d) AS row FROM ${quote(schema)}.department_shadow d ORDER BY department_id`)).rows.map(r=>r.row);
  if(JSON.stringify(saved)!==JSON.stringify(locked.departments.map(d=>d.shadow).sort((a,b)=>a.department_id-b.department_id)))throw Error('Shadow department backup differs');
  if((await client.query("SELECT to_regclass('public.department_cities') AS present")).rows[0].present){
   await client.query(`CREATE TABLE ${quote(schema)}.department_cities_shadow (LIKE public.department_cities INCLUDING ALL)`);
   await client.query(`INSERT INTO ${quote(schema)}.department_cities_shadow SELECT * FROM department_cities WHERE department_id=ANY($1::int[])`,[ids]);
   const links=(await client.query(`SELECT to_jsonb(d) AS row FROM ${quote(schema)}.department_cities_shadow d ORDER BY to_jsonb(d)::text`)).rows.map(r=>r.row);
   if(JSON.stringify(links)!==JSON.stringify(locked.departments.flatMap(d=>d.cityLinks)))throw Error('Shadow department-city backup differs');
   await client.query('DELETE FROM department_cities WHERE department_id=ANY($1::int[])',[ids]);
  }
  const removed=await client.query('DELETE FROM department WHERE department_id=ANY($1::int[])',[ids]);
  if(removed.rowCount!==ids.length)throw Error('Shadow department removal count mismatch');
 }
 await client.query(`CREATE TABLE ${quote(schema)}.cutover_journal(created_at timestamptz NOT NULL DEFAULT clock_timestamp(),plan jsonb NOT NULL)`);
 await client.query(`INSERT INTO ${quote(schema)}.cutover_journal(plan) VALUES($1::jsonb)`,[JSON.stringify(locked)]);
 return {archived:true,schema,tables:locked.tables,functions:locked.functions,permissions:locked.permissions,departments:locked.departments,preserved:true};
}
module.exports={inspectShadowSchema,archiveShadowSchema};
