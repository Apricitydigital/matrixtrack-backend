'use strict';
const crypto = require('node:crypto');
const {renameIdentifier,renameSql} = require('./selfAttendanceNaming');
const {fullRowFingerprint} = require('./fullRowFingerprint');
const quote = value => '"'+String(value).replace(/"/g,'""')+'"';
const name = value => renameIdentifier(value).slice(0,63);
const qualified = value => 'public.'+quote(value);
const exists = async (db,table) => Boolean((await db.query('SELECT to_regclass($1) IS NOT NULL AS present',[qualified(table)])).rows[0]?.present);
async function ensureMergeTriggers(db) {
  if(!await exists(db,'workforce_employee_aliases')||!(await db.query("SELECT to_regprocedure('workforce_redirect_employee_reference()') IS NOT NULL AS present")).rows[0]?.present)return [];
  const {references,installAliasTriggers,assertAliasTriggers}=require('./workforceMerge');
  const result=[];
  for(const kind of ['regular','self_attendance']){
    const plan={kind,links:await references(db,kind)};
    await installAliasTriggers(db,plan);await assertAliasTriggers(db,plan);
    result.push({kind,references:plan.links.length});
  }
  // The same references must be journaled for the existing 48-hour merge undo.
  if((await db.query("SELECT to_regprocedure('workforce_capture_merge_change()') IS NOT NULL AS present")).rows[0]?.present){
    const {recoveryTables}=require('./workforceMergeRecovery');
    let count=0;
    for(const table of await recoveryTables(db)){
      const trigger=(await db.query(`SELECT tgenabled,tgfoid=to_regprocedure('workforce_capture_merge_change()') AS correct
        FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname='workforce_capture_merge_change'`,[qualified(table)])).rows[0];
      if(trigger&&(!trigger.correct||!['O','A'].includes(trigger.tgenabled)))throw Error('Merge recovery trigger requires review: '+table);
      if(!trigger)await db.query(`CREATE TRIGGER workforce_capture_merge_change AFTER INSERT OR UPDATE OR DELETE ON ${qualified(table)}
        FOR EACH ROW EXECUTE FUNCTION workforce_capture_merge_change()`);
      count++;
    }
    result.push({kind:'recovery',tables:count});
  }
  return result;
}
async function catalog(db) {
  const rows = async sql => (await db.query(sql)).rows;
  return {
    relations: await rows(`SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','i','I') ORDER BY c.relname`),
    columns: await rows(`SELECT c.oid,c.relname,a.attname,t.typname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped JOIN pg_type t ON t.oid=a.atttypid
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname,a.attnum`),
    constraints: await rows(`SELECT oid,conrelid,conrelid::regclass::text AS table_name,conname,contype,convalidated,
      pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid<>0`),
    functions: await rows(`SELECT p.oid,p.proname,p.prokind,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND (p.proname ILIKE '%professional%' OR p.prosrc ILIKE '%professional%') ORDER BY p.oid`),
    triggers: await rows(`SELECT t.oid,t.tgrelid,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ILIKE '%professional%'`),
    allTriggers: await rows(`SELECT t.oid,c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`),
    enums: await rows(`SELECT t.oid,t.typname,e.enumlabel FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public' ORDER BY t.oid,e.enumsortorder`),
  };
}
async function installNormalizer(db) {
  // Keys are schema metadata. Values change only in named discriminator fields;
  // names, codes, emails, passwords, biometric blobs, URLs and S3 keys stay exact.
  const replacements=[['professional-attendance','self-attendance-records'],['professional_attendance','self_attendance_records'],['ProfessionalAttendance','SelfAttendanceRecords'],
    ['professionalAttendance','selfAttendanceRecords'],['PROFESSIONAL_ATTENDANCE','SELF_ATTENDANCE_RECORDS'],
    ['PROFESSIONAL','SELF_ATTENDANCE'],['Professional','SelfAttendance'],['professional-','self-attendance-'],['professional','self_attendance']];
  let expression='v';
  for(const [from,to] of replacements.slice(0,5))expression=`replace(${expression},'${from}','${to}')`;
  expression=`regexp_replace(${expression},'professional([A-Z])','selfAttendance\\1','g')`;
  for(const [from,to] of replacements.slice(5))expression=`replace(${expression},'${from}','${to}')`;
  await db.query(`CREATE OR REPLACE FUNCTION pg_temp.self_attendance_name(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
    SELECT ${expression} $fn$`);
  await db.query(`CREATE OR REPLACE FUNCTION pg_temp.self_attendance_display(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
    SELECT replace(replace(replace(replace(v,'Professional Attendance','Self Attendance'),'PROFESSIONAL','SELF ATTENDANCE'),'Professional','Self Attendance'),'professional','Self Attendance') $fn$`);
  await db.query(`CREATE OR REPLACE FUNCTION pg_temp.self_attendance_json(v jsonb, field text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql AS $fn$
    DECLARE result jsonb; item record; val text;
    BEGIN
      IF v IS NULL THEN RETURN NULL; END IF;
      IF position('professional' IN lower(v::text))=0 THEN RETURN v; END IF;
      IF jsonb_typeof(v)='object' THEN
        result:='{}'::jsonb;
        FOR item IN SELECT key,value FROM jsonb_each(v) LOOP
          IF result ? pg_temp.self_attendance_name(item.key) THEN RAISE EXCEPTION 'Conflicting JSON attendance names'; END IF;
          result:=result||jsonb_build_object(pg_temp.self_attendance_name(item.key),pg_temp.self_attendance_json(item.value,item.key));
        END LOOP;
        RETURN result;
      ELSIF jsonb_typeof(v)='array' THEN
        SELECT COALESCE(jsonb_agg(pg_temp.self_attendance_json(value,field) ORDER BY ord),'[]'::jsonb) INTO result
          FROM jsonb_array_elements(v) WITH ORDINALITY a(value,ord); RETURN result;
      ELSIF jsonb_typeof(v)='string' THEN
        val:=v#>>'{}';
        IF field IN ('department_name','designation_name','employee_type') AND lower(trim(val))='professional' THEN RETURN to_jsonb('Self Attendance'::text); END IF;
        IF field IN ('employee_kind','kind','actor_type','actor_kind','user_type','userType','attendance_mode','type','module',
          'table','table_name','column','column_name','columns','key_columns','source_table','reference_column','field','source') THEN
          RETURN to_jsonb(pg_temp.self_attendance_name(val));
        END IF;
      END IF;
      RETURN v;
    END $fn$`);
}
const semantic=new Set(['employee_kind','kind','actor_type','actor_kind','user_type','attendance_mode','type','module','table_name','department_name','designation_name','source']);
async function digest(db,table,columns) {
  const patches=[],removed=[];
  for(const column of columns) {
    const from=column.attname,to=name(from),value='t.'+quote(from);
    let expression;
    if(table==='permissions'&&['label','description'].includes(from))expression=`to_jsonb(pg_temp.self_attendance_display(${value}))`;
    else if(['json','jsonb'].includes(column.typname))expression=`pg_temp.self_attendance_json(${value}::jsonb)`;
    else if(semantic.has(from)&&['text','varchar','bpchar'].includes(column.typname))expression=`pg_temp.self_attendance_json(to_jsonb(${value}),'${from}')`;
    else if(column.typname==='_text'&&['key_columns','scopes'].includes(from))expression=`to_jsonb(ARRAY(SELECT pg_temp.self_attendance_name(x) FROM unnest(${value}) x))`;
    else if(from!==to)expression=`to_jsonb(${value})`;
    if(expression){if(from!==to)removed.push(from);patches.push(`'${to}',${expression}`);}
  }
  let row='to_jsonb(t)';
  if(removed.length)row+=`-ARRAY[${removed.map(key=>`'${key}'`).join(',')}]::text[]`;
  if(patches.length)row=`(${row})||jsonb_build_object(${patches.join(',')})`;
  return (await db.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(row_hash,'' ORDER BY row_hash),'')) AS digest FROM
    (SELECT md5((${row})::text) AS row_hash FROM ${qualified(table)} t) rows`)).rows[0];
}
async function renameSelfAttendance(db,{onStep = () => {}} = {}) {
  // Caller owns BEGIN/COMMIT. Failure must roll back the entire operation.
  if((await db.query("SELECT evtname FROM pg_event_trigger WHERE evtenabled<>'D'")).rows.length)
    throw Error('Review enabled database event triggers before naming migration.');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('matrixtrack-self-attendance-rename-v1'))");
  const schema = await catalog(db);
  const oldTables = schema.relations.filter(r=>['r','p'].includes(r.relkind)&&/professional/i.test(r.relname));
  if(!oldTables.length) {
    if(!await exists(db,'self_attendance_employees')) throw Error('Neither legacy nor renamed employee schema exists.');
    if(schema.relations.some(r=>/professional/i.test(r.relname))||schema.columns.some(c=>/professional/i.test(c.attname))||schema.functions.length||schema.triggers.length)
      throw Error('Mixed schema detected; review legacy objects before retrying.');
    const untouchedAttendance=[];
    const histories=schema.relations.filter(r=>['r','p'].includes(r.relkind)&&['attendance','attendance_records','self_attendance_records'].includes(r.relname));
    for(const table of histories)await db.query(`LOCK TABLE ${qualified(table.relname)} IN SHARE ROW EXCLUSIVE MODE`);
    for(const table of histories)untouchedAttendance.push({table:table.relname,before:await fullRowFingerprint(db,table.relname)});
    const mergeTriggers=await ensureMergeTriggers(db);
    for(const table of untouchedAttendance){
      table.after=await fullRowFingerprint(db,table.table);
      if(JSON.stringify(table.before)!==JSON.stringify(table.after))throw Error('Attendance preservation check failed: '+table.table);
    }
    return {alreadyApplied:true,tables:[],mergeTriggers,untouchedAttendance};
  }
  for(const relation of schema.relations.filter(r=>/professional/i.test(r.relname))) {
    if(schema.relations.some(other=>other.oid!==relation.oid&&other.relname===name(relation.relname))) throw Error('Target relation already exists: '+name(relation.relname));
  }
  const ancillary = new Set(['department','designation','users','permissions','workforce_employee_aliases',
    'workforce_review_issues','workforce_merge_audit','workforce_merge_changes','workforce_deletion_audit','api_keys','user_consent_logs']);
  const tables = schema.relations.filter(r=>['r','p'].includes(r.relkind)&&
    (ancillary.has(r.relname)||/professional/i.test(r.relname)||schema.columns.some(c=>c.oid===r.oid&&/professional/i.test(c.attname))
      ||schema.constraints.some(c=>c.conrelid===r.oid&&c.contype==='c'&&/professional/i.test(c.definition))));
  // All writers must be drained for a cutover. Sorted locks prevent lock-order inversions.
  const untouched=schema.relations.filter(r=>['r','p'].includes(r.relkind)&&['attendance','attendance_records'].includes(r.relname)&&!tables.some(t=>t.oid===r.oid));
  for(const relation of [...tables,...untouched].sort((a,b)=>a.relname.localeCompare(b.relname))) await db.query(`LOCK TABLE ${qualified(relation.relname)} IN ACCESS EXCLUSIVE MODE`);
  const untouchedAttendance=[];
  for(const table of untouched){onStep('Protecting complete regular history: '+table.relname);untouchedAttendance.push({table:table.relname,before:await fullRowFingerprint(db,table.relname)});}
  await installNormalizer(db);
  const before = new Map();
  onStep('Fingerprinting employees, attendance and dependent rows');
  for(const table of tables) {onStep('Fingerprint: '+table.relname);before.set(table.oid,await digest(db,table.relname,schema.columns.filter(c=>c.oid===table.oid)));}
  await db.query("SELECT set_config('matrixtrack.merge_replay','on',true)");
  await db.query('SET LOCAL check_function_bodies = off');
  // A changed CHECK needs its literals replaced before discriminator values move.
  const checks=schema.constraints.filter(c=>c.contype==='c'&&/professional/i.test(c.definition));
  for(const c of checks)await db.query(`ALTER TABLE ${qualified(schema.relations.find(r=>r.oid===c.conrelid).relname)} DROP CONSTRAINT ${quote(c.conname)}`);
  // Trigger arguments are strings, so PostgreSQL cannot update them on column rename.
  for(const trigger of schema.triggers)await db.query(`DROP TRIGGER ${quote(trigger.tgname)} ON ${qualified(trigger.relname)}`);
  const suspended=schema.allTriggers.filter(t=>t.tgenabled!=='D'&&tables.some(r=>r.relname===t.relname)&&!schema.triggers.some(r=>r.oid===t.oid));
  // Naming metadata updates must not change timestamps or produce fresh audit rows.
  // Internal FK/uniqueness enforcement stays active throughout the transaction.
  for(const trigger of suspended)await db.query(`ALTER TABLE ${qualified(trigger.relname)} DISABLE TRIGGER ${quote(trigger.tgname)}`);
  onStep('Renaming existing schema objects without copying employee or attendance rows');
  for(const relation of schema.relations.filter(r=>['r','p','S','v','m'].includes(r.relkind)&&/professional/i.test(r.relname))) {
    const kind={r:'TABLE',p:'TABLE',S:'SEQUENCE',v:'VIEW',m:'MATERIALIZED VIEW'}[relation.relkind];
    await db.query(`ALTER ${kind} ${qualified(relation.relname)} RENAME TO ${quote(name(relation.relname))}`);
  }
  for(const column of schema.columns.filter(c=>/professional/i.test(c.attname))) {
    if(schema.columns.some(c=>c.oid===column.oid&&c.attname===name(column.attname)))throw Error('Target column already exists: '+column.attname);
    const relation = schema.relations.find(r=>r.oid===column.oid);
    const kind={r:'TABLE',p:'TABLE',v:'VIEW',m:'MATERIALIZED VIEW'}[relation.relkind];
    await db.query(`ALTER ${kind} ${qualified(name(column.relname))} RENAME COLUMN ${quote(column.attname)} TO ${quote(name(column.attname))}`);
  }
  // ALTER keeps function OIDs (and all trigger/dependency links).
  for(const fn of schema.functions.filter(f=>/professional/i.test(f.proname)))
    await db.query(`ALTER ${fn.prokind==='p'?'PROCEDURE':'FUNCTION'} ${qualified(fn.proname)}(${fn.args}) RENAME TO ${quote(name(fn.proname))}`);
  for(const fn of schema.functions) await db.query(renameSql(fn.definition));
  for(const type of [...new Map(schema.enums.map(e=>[e.oid,e])).values()].filter(e=>/professional/i.test(e.typname)))
    await db.query(`ALTER TYPE ${qualified(type.typname)} RENAME TO ${quote(name(type.typname))}`);
  for(const e of schema.enums.filter(e=>/professional/i.test(e.enumlabel)))
    await db.query(`ALTER TYPE ${qualified(name(e.typname))} RENAME VALUE '${e.enumlabel.replace(/'/g,"''")}' TO '${renameIdentifier(e.enumlabel).replace(/'/g,"''")}'`);
  // Constraint renames also rename their backing UNIQUE/PRIMARY KEY indexes.
  for(const c of schema.constraints.filter(c=>/professional/i.test(c.conname)&&!checks.includes(c))) {
    const relation=schema.relations.find(r=>r.oid===c.conrelid);if(!relation)continue;
    await db.query(`ALTER TABLE ${qualified(name(relation.relname))} RENAME CONSTRAINT ${quote(c.conname)} TO ${quote(name(c.conname))}`);
  }
  for(const c of checks) {
    const relation=schema.relations.find(r=>r.oid===c.conrelid);
    // NOT VALID is temporary, allowing an old discriminator to be migrated atomically.
    await db.query(`ALTER TABLE ${qualified(name(relation.relname))} ADD CONSTRAINT ${quote(name(c.conname))} ${renameSql(c.definition).replace(/\s+NOT VALID$/i,'')} NOT VALID`);
  }
  const indexes=(await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('i','I') AND c.relname ILIKE '%professional%'`)).rows;
  for(const index of indexes)await db.query(`ALTER INDEX ${qualified(index.relname)} RENAME TO ${quote(name(index.relname))}`);
  onStep('Updating discriminator values, permission keys and recovery metadata');
  const columnTypes=(await db.query(`SELECT c.oid,c.relname,a.attname,t.typname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped JOIN pg_type t ON t.oid=a.atttypid
    WHERE n.nspname='public' AND c.relkind IN ('r','p')`)).rows;
  for(const column of columnTypes.filter(c=>tables.some(t=>t.oid===c.oid))) {
    let expression;
    if(column.relname==='permissions'&&['label','description'].includes(column.attname))expression=`pg_temp.self_attendance_display(${quote(column.attname)})`;
    else if(column.typname==='jsonb')expression=`pg_temp.self_attendance_json(${quote(column.attname)})`;
    else if(column.typname==='json')expression=`pg_temp.self_attendance_json(${quote(column.attname)}::jsonb)::json`;
    else if(['text','varchar','bpchar'].includes(column.typname)&&semantic.has(column.attname))
      expression=`(pg_temp.self_attendance_json(to_jsonb(${quote(column.attname)}),'${column.attname}')#>>'{}')`;
    else if(column.typname==='_text'&&['key_columns','scopes'].includes(column.attname))
      expression=`ARRAY(SELECT pg_temp.self_attendance_name(x) FROM unnest(${quote(column.attname)}) x)`;
    if(expression)await db.query(`UPDATE ${qualified(column.relname)} SET ${quote(column.attname)}=${expression}
      WHERE ${quote(column.attname)} IS NOT NULL AND ${quote(column.attname)}::text ILIKE '%professional%'`);
  }
  for(const c of checks.filter(c=>c.convalidated))await db.query(`ALTER TABLE ${qualified(name(schema.relations.find(r=>r.oid===c.conrelid).relname))} VALIDATE CONSTRAINT ${quote(name(c.conname))}`);
  for(const trigger of schema.triggers) {
    let definition=renameSql(trigger.definition);
    let triggerName=name(trigger.tgname);
    if(trigger.tgname.startsWith('workforce_alias_')) {
      const args=definition.match(/workforce_redirect_employee_reference\('([^']+)',\s*'([^']+)'\)/);
      if(!args)throw Error('Unrecognized alias trigger arguments: '+trigger.tgname);
      triggerName='workforce_alias_'+crypto.createHash('sha256').update(`${args[1]}:${name(trigger.relname)}:${args[2]}`).digest('hex').slice(0,24);
      definition=definition.replace(new RegExp('CREATE TRIGGER "?'+trigger.tgname+'"?'),'CREATE TRIGGER '+quote(triggerName));
    }
    await db.query(definition);
    if(trigger.tgenabled!=='O')await db.query(`ALTER TABLE ${qualified(name(trigger.relname))} ${ {D:'DISABLE TRIGGER',R:'ENABLE REPLICA TRIGGER',A:'ENABLE ALWAYS TRIGGER'}[trigger.tgenabled]} ${quote(triggerName)}`);
  }
  for(const trigger of suspended)await db.query(`ALTER TABLE ${qualified(name(trigger.relname))} ${ {O:'ENABLE TRIGGER',R:'ENABLE REPLICA TRIGGER',A:'ENABLE ALWAYS TRIGGER'}[trigger.tgenabled]} ${quote(trigger.tgname)}`);
  const views=(await db.query(`SELECT c.relname,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'`)).rows;
  for(const view of views.filter(v=>/professional/i.test(v.definition)))await db.query(`CREATE OR REPLACE VIEW ${qualified(view.relname)} AS ${renameSql(view.definition)}`);
  await db.query('SET LOCAL check_function_bodies = on');
  const report=[];
  onStep('Verifying every affected row and existing schema-object identity');
  for(const table of tables) {
    onStep('Verify: '+name(table.relname));
    const after=await digest(db,name(table.relname),schema.columns.filter(c=>c.oid===table.oid).map(c=>({...c,attname:name(c.attname)}))),original=before.get(table.oid);
    if(after.count!==original.count||after.digest!==original.digest)throw Error('Data preservation check failed: '+table.relname);
    report.push({before:table.relname,after:name(table.relname),rows:after.count,digest:after.digest});
  }
  const remaining=await catalog(db);
  for(const table of tables)if(!remaining.relations.some(r=>r.oid===table.oid&&r.relname===name(table.relname)))
    throw Error('Table identity changed during rename: '+table.relname);
  for(const fk of schema.constraints.filter(c=>c.contype==='f'))if(!remaining.constraints.some(c=>c.oid===fk.oid))
    throw Error('A foreign-key identity changed during rename: '+fk.conname);
  if(remaining.relations.some(r=>/professional/i.test(r.relname))||remaining.columns.some(c=>/professional/i.test(c.attname))||remaining.functions.length||remaining.triggers.length)
    throw Error('Legacy schema references remain; cutover rolled back.');
  const mergeTriggers=await ensureMergeTriggers(db);
  for(const table of untouchedAttendance){
    table.after=await fullRowFingerprint(db,table.table);
    if(JSON.stringify(table.before)!==JSON.stringify(table.after))throw Error('Attendance preservation check failed: '+table.table);
  }
  await db.query("SELECT set_config('matrixtrack.merge_replay','off',true)");
  return {alreadyApplied:false,tables:report,renamedTables:oldTables.length,mergeTriggers,untouchedAttendance};
}
module.exports={renameSelfAttendance,catalog,digest,installNormalizer};
