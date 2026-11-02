'use strict';
const {fullRowFingerprint} = require('./fullRowFingerprint');
const {previewWardNames,assertValidNamePlan,nameOverrides,applyWardNamePlan}=require('./wardNameMigration');
const {capturePayrollInputs,assertPayrollInputsUnchanged}=require('./payrollAttendanceReconciliation');

// Caller owns the transaction. Sector retirement can also combine Ward names;
// current employee Ward links, legacy profile/policy snapshots and punches are
// protected independently. No table/column or historical Sector is deleted.
const protectedNames = [
  'employee','users','designation','department','attendance','attendance_records',
  'self_attendance_employees','self_punch_requests','self_attendance_records',
  'self_attendance_site_access','self_attendance_geofences','self_attendance_geofence_requests',
  'self_attendance_holidays','self_attendance_leave_requests','self_attendance_punch_blocks',
  'self_attendance_records_blocks','self_attendance_records_block_history','self_attendance_designation_assignments',
  'self_attendance_week_off_versions','self_attendance_feature_settings','self_attendance_punch_cutoffs',
  'self_attendance_punch_activity','self_attendance_punch_settings','self_attendance_punch_setting_history',
  'self_attendance_notifications','self_attendance_push_tokens','self_attendance_holiday_logs',
  'self_attendance_leave_request_logs','self_attendance_geofence_request_logs','self_punch_request_logs',
  'self_attendance_weekly_off','self_attendance_weekly_off_rules','self_attendance_weekly_off_assignments',
  'user_kothi_access','user_city_access','user_zone_access','supervisor_ward','supervisor_kothi',
  'supervisor_attendance_faces','register_attendance_requests','employee_transfer_history','supervisor_transfer_history',
  'cities','zones','sectors','permissions','api_keys',
  'self_attendance_week_off','self_attendance_leave_allocations','self_attendance_leave_allocation_logs',
];
const fail = message => {throw new Error(message);};
function viewOptionsSql(options=[]){
 if(options.some(option=>!/^security_(barrier|invoker)=(true|false)$/.test(option)))fail('Review dashboard view options before replacing its definition.');
 return options.length?' WITH ('+options.join(',')+')':'';
}
async function accessSnapshot(client,tables) {
  const needed=['users','supervisor_ward','supervisor_kothi','user_kothi_access','user_zone_access','user_city_access','self_attendance_employees','self_punch_requests'];
  if(!needed.every(name=>tables.includes(name)))return {verified:false,reason:'Minimal fixture lacks scope tables'};
  const {buildVisibilityScope}=require('./selfAttendanceAccess');
  const {cte,whereClause}=buildVisibilityScope({role:'supervisor',user_id:1},null,'p',{legacyWardScope:true});
  const sqlScope=cte.replace(/\$1\b/g,'actor.user_id');
  const result={verified:true};
  for(const table of ['self_attendance_employees','self_punch_requests'])result[table]=(await client.query(`SELECT actor.user_id,scoped.* FROM users actor
    CROSS JOIN LATERAL (${sqlScope} SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(p.id::text,',' ORDER BY p.id),'')) AS checksum FROM "${table}" p WHERE ${whereClause}) scoped
    WHERE lower(actor.role::text)='supervisor' ORDER BY actor.user_id`)).rows;
  return result;
}
async function available(client) {
  return (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename`,[protectedNames])).rows.map(row=>row.tablename);
}
async function fingerprint(client, tables, progress=()=>{}, {fullAttendance = false} = {}) {
  const result={};
  for(const name of tables) {
    progress(`Checking ${name}`);
    // Keep the historical lightweight baseline available to older audit tools.
    // Migration and restoration always request the complete row-content check.
    if(name==='attendance') {
      result[name]=(await client.query('SELECT count(*)::text AS count,sum(attendance_id::numeric)::text AS id_sum FROM attendance')).rows[0];
      result[name].validation='IDs/count; no attendance writes or enabled Ward triggers';
      if(fullAttendance) {
        const full=await fullRowFingerprint(client,name);
        if(full.count!==result[name].count)fail('Attendance count changed while fingerprinting. Stop all writers.');
        result[name].row_sha256=full.row_sha256;
        result[name].validation='All row contents: sorted full-row MD5 fingerprints hashed with SHA-256; count and ID sum';
      }
      continue;
    }
    result[name]=(await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS checksum FROM
    (SELECT md5(to_jsonb(t)::text) AS h FROM "${name}" t) rows`)).rows[0];
  }
  result.wards=await fingerprintWards(client);
  return result;
}
async function fingerprintWards(client,overrides=[]) {
  if(overrides.length)return (await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS checksum FROM
    (SELECT md5(((to_jsonb(w)-'sector_id') || CASE WHEN p.ward_id IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('ward_name',p.ward_name) END)::text) AS h
      FROM wards w LEFT JOIN jsonb_to_recordset($1::jsonb) AS p(ward_id int,ward_name text) ON p.ward_id=w.ward_id) rows`,[JSON.stringify(overrides)])).rows[0];
  return (await client.query(`SELECT count(*)::text AS count,
    md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS checksum FROM
    (SELECT md5((to_jsonb(w)-'sector_id')::text) AS h FROM wards w) rows`)).rows[0];
}
async function lockProtectedData(client,tables) {
  const names=[...new Set([...tables,'wards'])].sort();
  await client.query(`LOCK TABLE ${names.map(name=>'public."'+name.replace(/"/g,'""')+'"').join(',')} IN SHARE ROW EXCLUSIVE MODE`);
  if((await client.query("SELECT evtname FROM pg_event_trigger WHERE evtenabled<>'D'")).rows.length)fail('Review enabled database event triggers before migration; protected rows must not be modified by DDL.');
}
async function retireSectorMemberships(client, progress=()=>{}, {requireCompleteSchema=false,combineWardNames=false}={}) {
  await client.query("SET LOCAL lock_timeout='5s'");
  // Stop concurrent parent edits; other table snapshots stay consistent when the
  // runner opens REPEATABLE READ. A concurrent write conflict aborts safely.
  await client.query('LOCK TABLE wards IN SHARE ROW EXCLUSIVE MODE');
  const tables=await available(client);
  if(requireCompleteSchema) {
    const required=['employee','attendance','users','supervisor_ward','supervisor_kothi','user_kothi_access','user_zone_access','user_city_access','self_attendance_employees','self_punch_requests','self_attendance_records'];
    const missing=required.filter(name=>!tables.includes(name));
    if(missing.length)fail('Complete production preservation checks require tables: '+missing.join(', '));
  }
  await lockProtectedData(client,tables);
  const triggers=(await client.query("SELECT tgname FROM pg_trigger WHERE tgrelid='wards'::regclass AND NOT tgisinternal AND tgenabled<>'D'")).rows;
  if(triggers.length)fail('Review enabled Ward triggers before retirement; history must have no indirect write path.');
  const invalid=(await client.query(`SELECT count(*)::int AS count FROM wards w
    LEFT JOIN zones z ON z.zone_id=w.zone_id LEFT JOIN cities c ON c.city_id=z.city_id
    LEFT JOIN sectors s ON s.sector_id=w.sector_id
    WHERE z.zone_id IS NULL OR c.city_id IS NULL OR
      (w.sector_id IS NOT NULL AND (s.sector_id IS NULL OR s.zone_id<>w.zone_id))`)).rows[0].count;
  if(invalid)fail('Every Ward needs a valid direct Zone/City with no conflicting Sector before retirement.');
  // The CLI enables this automatically. Library callers can retain their legacy
  // name-preserving behavior; the approved name map is never inferred from IDs.
  const namePlan=combineWardNames?await previewWardNames(client):null;
  if(namePlan)assertValidNamePlan(namePlan);
  await client.query(`CREATE TABLE IF NOT EXISTS ward_sector_retirement_backup (
    ward_id INTEGER PRIMARY KEY, sector_id INTEGER, zone_id INTEGER NOT NULL,
    retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
  // This view serves only legacy authorization/policy interpretation. Active
  // geography continues to read wards, where sector_id becomes NULL.
  await client.query(`CREATE OR REPLACE VIEW ward_legacy_sector_links AS
    SELECT w.ward_id,COALESCE(w.sector_id,CASE WHEN b.zone_id=w.zone_id THEN b.sector_id END) AS sector_id,w.zone_id,w.ward_name
    FROM wards w LEFT JOIN ward_sector_retirement_backup b USING(ward_id)`);
  for(const name of ['supervisor_ward','supervisor_kothi','user_kothi_access'])if(tables.includes(name)){
    const n=(await client.query(`SELECT count(*)::int AS count FROM "${name}" a LEFT JOIN wards w ON w.ward_id=a.ward_id WHERE w.ward_id IS NULL`)).rows[0].count;
    if(n)fail(`${name} has legacy or orphan access mappings. Convert them to explicit physical Ward IDs before retirement.`);
  }
  if(tables.includes('employee')){
    const n=(await client.query('SELECT count(*)::int AS count FROM employee e LEFT JOIN wards w ON w.ward_id=e.ward_id WHERE w.ward_id IS NULL')).rows[0].count;
    if(n)fail('Employee Master contains missing physical Ward links.');
  }
  for(const name of ['self_attendance_employees','self_punch_requests'])if(tables.includes(name)){
    const n=(await client.query(`SELECT count(*)::int AS count FROM "${name}" p LEFT JOIN wards w ON w.ward_id=p.kothi_id
      WHERE w.ward_id IS NULL OR w.zone_id IS DISTINCT FROM p.zone_id`)).rows[0].count;
    if(n)fail(`${name} has ambiguous/missing physical Ward links or conflicting Zones. Resolve them explicitly first.`);
  }
  if(tables.includes('self_attendance_holidays')){
    const n=(await client.query('SELECT count(*)::int AS count FROM self_attendance_holidays WHERE ward_id IS NOT NULL AND kothi_id IS NULL')).rows[0].count;
    if(n)fail('Sector-scoped holidays must be translated to explicit physical Ward scopes before retirement.');
  }
  const views=(await client.query("SELECT viewname,definition FROM pg_views WHERE schemaname='public' AND (definition ILIKE '%sector_id%' OR definition ILIKE '%sectors%')")).rows;
  const viewChanges=[];
  for(const view of views) {
    if(view.viewname==='ward_legacy_sector_links')continue;
    if(view.viewname!=='attendance_dashboard_view')fail(`Review dependent view ${view.viewname} before retirement.`);
    if(!/LEFT JOIN sectors s\b/i.test(view.definition)||!/LEFT JOIN zones z ON \(\(w.zone_id = z.zone_id\)\)/i.test(view.definition))fail('Unrecognized dashboard view joins; review them before retirement.');
    const columns=(await client.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='attendance_dashboard_view'::regclass AND attname IN ('ward_id','ward_name') AND NOT attisdropped")).rows;
    let definition=view.definition;
    for(const column of columns){
      const limit=column.type.match(/^character varying\((\d+)\)$/);
      if(column.attname==='ward_name'&&limit&&(await client.query('SELECT 1 FROM wards WHERE length(ward_name)>$1 LIMIT 1',[Number(limit[1])])).rows.length)fail('Dashboard Ward name type is too narrow; widen the view deliberately before retirement.');
      definition=definition.replace(new RegExp(`s\\.sector_${column.attname==='ward_id'?'id':'name'} AS ${column.attname}\\b`,'i'),`w.${column.attname}::${column.type} AS ${column.attname}`);
    }
    if(definition!==view.definition){
      const options=(await client.query("SELECT reloptions FROM pg_class WHERE oid='attendance_dashboard_view'::regclass")).rows[0].reloptions||[];
      viewOptionsSql(options);
      viewChanges.push({...view,options,updated:definition});
    }
  }
  const accessBefore=await accessSnapshot(client,tables);
  const before=await fingerprint(client,tables,progress,{fullAttendance:true});
  const payrollBefore=requireCompleteSchema?await capturePayrollInputs(client):null;
  const expectedAfter=namePlan?{...before,wards:await fingerprintWards(client,nameOverrides(namePlan))}:before;
  await client.query(`CREATE TABLE IF NOT EXISTS ward_sector_retirement_backup (
    ward_id INTEGER PRIMARY KEY, sector_id INTEGER, zone_id INTEGER NOT NULL,
    retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
  // Never overwrite the original rollback map on reruns.
  await client.query(`INSERT INTO ward_sector_retirement_backup(ward_id,sector_id,zone_id)
    SELECT ward_id,sector_id,zone_id FROM wards ON CONFLICT(ward_id) DO NOTHING`);
  const conflict=(await client.query(`SELECT count(*)::int AS count FROM wards w JOIN ward_sector_retirement_backup b USING(ward_id)
    WHERE w.sector_id IS NOT NULL AND (w.sector_id IS DISTINCT FROM b.sector_id OR w.zone_id<>b.zone_id)`)).rows[0].count;
  if(conflict)fail('Existing rollback map conflicts with current memberships. Do not overwrite the backup.');
  const combinedNames=namePlan?await applyWardNamePlan(client,namePlan):{changed:0};
  const changed=await client.query('UPDATE wards SET sector_id=NULL WHERE sector_id IS NOT NULL');
  // Take the brief schema lock only after the expensive validation scans.
  const exists=(await client.query("SELECT 1 FROM pg_constraint WHERE conrelid='wards'::regclass AND conname='wards_retired_sector_null'" )).rows.length;
  if(!exists)await client.query('ALTER TABLE wards ADD CONSTRAINT wards_retired_sector_null CHECK (sector_id IS NULL)');
  // These snapshot columns contain the retired Sector; employee.ward_id is a
  // physical Ward reference and is never altered here.
  await client.query(`CREATE TABLE IF NOT EXISTS ward_sector_retirement_columns(
    table_name TEXT PRIMARY KEY,was_not_null BOOLEAN NOT NULL)`);
  const nullableParents=[];
  for(const name of ['self_punch_requests','self_attendance_employees','self_attendance_records'])if(tables.includes(name)){
    const col=(await client.query("SELECT attnotnull FROM pg_attribute WHERE attrelid=$1::regclass AND attname='ward_id' AND NOT attisdropped",[name])).rows[0];
    if(!col)fail(`Missing deprecated parent column in ${name}; review schema.`);
    await client.query('INSERT INTO ward_sector_retirement_columns(table_name,was_not_null) VALUES($1,$2) ON CONFLICT(table_name) DO NOTHING',[name,col.attnotnull]);
    if(col.attnotnull){await client.query(`ALTER TABLE "${name}" ALTER COLUMN ward_id DROP NOT NULL`);nullableParents.push(name+'.ward_id');}
  }
  if(viewChanges.length){
    await client.query('CREATE TABLE IF NOT EXISTS ward_sector_retirement_views(view_name TEXT PRIMARY KEY,definition TEXT NOT NULL,view_options TEXT[])');
    await client.query('ALTER TABLE ward_sector_retirement_views ADD COLUMN IF NOT EXISTS view_options TEXT[]');
    for(const view of viewChanges){
      await client.query('INSERT INTO ward_sector_retirement_views(view_name,definition,view_options) VALUES($1,$2,$3) ON CONFLICT(view_name) DO NOTHING',[view.viewname,view.definition,view.options]);
      await client.query(`CREATE OR REPLACE VIEW attendance_dashboard_view${viewOptionsSql(view.options)} AS ${view.updated}`);
    }
  }
  // Verify after every schema/view change, immediately before the caller commits.
  const after=await fingerprint(client,tables,progress,{fullAttendance:true});
  if(JSON.stringify(expectedAfter)!==JSON.stringify(after))fail('Protected employee/history/access data changed. Roll back immediately.');
  const accessAfter=await accessSnapshot(client,tables);
  if(JSON.stringify(accessBefore)!==JSON.stringify(accessAfter)){
    const error=new Error('Supervisor visibility changed. Resolve explicit Ward scopes before retirement.');
    error.details=Object.fromEntries(['self_attendance_employees','self_punch_requests'].map(name=>[name,
      (accessBefore[name]||[]).flatMap((row,index)=>JSON.stringify(row)===JSON.stringify(accessAfter[name]?.[index])?[]:[{user_id:row.user_id,before:row,after:accessAfter[name]?.[index]}])]));
    throw error;
  }
  const payrollInputs=payrollBefore?assertPayrollInputsUnchanged(payrollBefore,await capturePayrollInputs(client)):null;
  return {changed:changed.rowCount,combinedNames:combinedNames.changed,namePlan,payrollInputs,payrollInputsVerified:payrollInputs?.verified??false,nullableParents,updatedViews:viewChanges.map(v=>v.viewname),protectedTables:Object.keys(before),before,expectedAfter,after,accessBefore,accessAfter,protectedDataUnchanged:true};
}

async function restoreSectorMemberships(client,progress=()=>{},{verifyPayrollInputs=false}={}) {
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query('LOCK TABLE wards IN SHARE ROW EXCLUSIVE MODE');
  if(!(await client.query("SELECT to_regclass('public.ward_sector_retirement_backup') AS backup")).rows[0].backup)fail('Original rollback map is missing.');
  if((await client.query(`SELECT 1 FROM ward_sector_retirement_backup b
    LEFT JOIN wards w USING(ward_id) LEFT JOIN sectors s ON s.sector_id=b.sector_id
    WHERE w.ward_id IS NULL OR w.zone_id<>b.zone_id OR (b.sector_id IS NOT NULL AND s.sector_id IS NULL)
      OR (w.sector_id IS NOT NULL AND w.sector_id IS DISTINCT FROM b.sector_id) LIMIT 1`)).rows.length)fail('Ward/Zone/Sector data changed since cutover; review rollback mapping instead of overwriting it.');
  if((await client.query("SELECT 1 FROM pg_trigger WHERE tgrelid='wards'::regclass AND NOT tgisinternal AND tgenabled<>'D'")).rows.length)fail('Review enabled Ward triggers before rollback.');
  const tables=await available(client);
  await lockProtectedData(client,tables);
  const namePlan=await previewWardNames(client,{restore:true});assertValidNamePlan(namePlan);
  const before=await fingerprint(client,tables,progress,{fullAttendance:true});
  const payrollBefore=verifyPayrollInputs?await capturePayrollInputs(client):null;
  const expectedAfter={...before,wards:await fingerprintWards(client,nameOverrides(namePlan))};
  const restoredNames=await applyWardNamePlan(client,namePlan);
  await client.query('ALTER TABLE wards DROP CONSTRAINT IF EXISTS wards_retired_sector_null');
  const changed=await client.query('UPDATE wards w SET sector_id=b.sector_id FROM ward_sector_retirement_backup b WHERE w.ward_id=b.ward_id AND w.sector_id IS DISTINCT FROM b.sector_id');
  if((await client.query("SELECT to_regclass('public.ward_sector_retirement_views') AS backup")).rows[0].backup){
    const views=(await client.query('SELECT * FROM ward_sector_retirement_views')).rows;
    for(const view of views){
      if(view.view_name!=='attendance_dashboard_view')fail('Unexpected view in rollback map.');
      const current=(await client.query("SELECT reloptions FROM pg_class WHERE oid='attendance_dashboard_view'::regclass")).rows[0].reloptions||[];
      if(view.view_options!=null&&JSON.stringify([...view.view_options].sort())!==JSON.stringify([...current].sort()))fail('Dashboard security options changed since cutover; review rollback instead of overwriting them.');
      await client.query(`CREATE OR REPLACE VIEW attendance_dashboard_view${viewOptionsSql(view.view_options??current)} AS ${view.definition}`);
    }
  }
  const after=await fingerprint(client,tables,progress,{fullAttendance:true});
  if(JSON.stringify(expectedAfter)!==JSON.stringify(after))fail('Rollback changed protected employee/history/access data.');
  // Retain nullable snapshot fields on rollback: valid new profiles/punches may
  // already contain NULL. Never invent parent IDs to restore a constraint.
  const payrollInputs=payrollBefore?assertPayrollInputsUnchanged(payrollBefore,await capturePayrollInputs(client)):null;
  return {changed:changed.rowCount,restoredNames:restoredNames.changed,namePlan,payrollInputs,payrollInputsVerified:payrollInputs?.verified??false,nullableLegacyColumnsPreserved:true,protectedTables:Object.keys(before),before,expectedAfter,after,protectedDataUnchanged:true};
}
module.exports={retireSectorMemberships,restoreSectorMemberships,fingerprint,available,accessSnapshot};
