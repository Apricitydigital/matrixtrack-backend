'use strict';
const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const key = value => clean(value).toLowerCase();
// Skip cosmetic repeats such as "Head Office - HMS" / "Head Office- HMS".
// This normalization is only for prefix detection, never for IDs or SQL names.
const labelKey = value => key(value).replace(/\s*[-–—]\s*/g,'-').replace(/\s*\+\s*/g,'+');
const length = value => Array.from(String(value ?? '')).length;
const backupTable = 'ward_name_retirement_backup';
const exists = async (db, name) => Boolean((await db.query('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + name])).rows[0]?.present);

async function metadata(db) {
  const hasParents = await exists(db, 'ward_sector_retirement_backup');
  const hasNames = await exists(db, backupTable);
  const rows = (await db.query(`SELECT w.ward_id,w.zone_id,w.sector_id,w.ward_name,
    ${hasParents ? 'b.sector_id AS saved_sector_id,b.zone_id AS saved_zone_id,' : 'NULL::int AS saved_sector_id,NULL::int AS saved_zone_id,'}
    s.sector_id AS parent_id,s.sector_name,s.zone_id AS parent_zone_id,
    z.zone_id AS valid_zone_id,c.city_id AS valid_city_id
    FROM wards w ${hasParents ? 'LEFT JOIN ward_sector_retirement_backup b USING(ward_id)' : ''}
    LEFT JOIN sectors s ON s.sector_id=COALESCE(w.sector_id,${hasParents ? 'b.sector_id' : 'NULL::int'})
    LEFT JOIN zones z ON z.zone_id=w.zone_id LEFT JOIN cities c ON c.city_id=z.city_id ORDER BY w.ward_id`)).rows;
  const backups = hasNames ? (await db.query(`SELECT * FROM ${backupTable} ORDER BY ward_id`)).rows : [];
  const limits = (await db.query(`SELECT table_name,column_name,character_maximum_length AS max_length
    FROM information_schema.columns WHERE table_schema='public' AND
    ((table_name='wards' AND column_name='ward_name') OR
     (table_name='attendance_dashboard_view' AND column_name IN ('ward_name','kothi_name')))
    AND character_maximum_length IS NOT NULL`)).rows;
  const indexes = (await db.query(`SELECT pg_get_indexdef(i.indexrelid) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
      LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS columns
    FROM pg_index i WHERE i.indrelid='public.wards'::regclass AND i.indisunique AND NOT i.indisprimary`)).rows;
  return {rows, backups, limits, indexes};
}

function validateNames(plan, meta) {
  const add = (type, row, detail) => plan.issues.push({type,ward_id:row?.ward_id ?? null,detail});
  for (const row of plan.rows) {
    if (!clean(row.proposed_name)) add('blank_name',row,'Ward name must not be blank');
    for (const limit of meta.limits) if (length(row.proposed_name)>Number(limit.max_length))
      add('name_too_long',row,`${limit.table_name}.${limit.column_name} permits ${limit.max_length} characters; proposed name has ${length(row.proposed_name)}`);
  }
  let globalUnique = false;
  for (const index of meta.indexes) {
    if (!/ward_name/i.test(index.definition)) continue;
    if (index.columns.length===1 && index.columns[0]==='ward_name') globalUnique=true;
    else if (!(index.columns.length===2 && index.columns.includes('ward_name') && index.columns.includes('zone_id')))
      add('unreviewed_name_index',null,index.definition);
  }
  // Avoid ambiguous display labels even when the DB index is case-sensitive.
  const group = row => (globalUnique ? '' : String(row.zone_id)+':');
  const proposed = new Map(), current = new Map();
  for (const row of plan.rows) {
    const before=group(row)+key(row.current_name), after=group(row)+key(row.proposed_name);
    if (!current.has(before)) current.set(before,[]);
    current.get(before).push(row.ward_id);
    if (proposed.has(after)) add('duplicate_name',row,`Proposed name conflicts with Ward ${proposed.get(after)}`);
    else proposed.set(after,row.ward_id);
  }
  for (const row of plan.rows.filter(row=>row.action==='rename'||row.action==='restore')) {
    const conflicts=(current.get(group(row)+key(row.proposed_name))||[]).filter(id=>String(id)!==String(row.ward_id));
    if (conflicts.length) add('name_transition_conflict',row,`Name is currently held by Ward ${conflicts.join(', ')}; review before updating`);
  }
  plan.valid=plan.issues.length===0;
  const maximum=plan.rows.reduce((n,row)=>Math.max(n,length(row.proposed_name)),0);
  plan.requiredNameCapacity=meta.limits.filter(limit=>maximum>Number(limit.max_length)).map(limit=>({
    table:limit.table_name,column:limit.column_name,currentLimit:Number(limit.max_length),minimumRequired:maximum}));
  plan.changedNames=plan.rows.filter(row=>row.action==='rename'||row.action==='restore').length;
  plan.alreadyApplied=plan.rows.filter(row=>row.action==='already_applied').length;
  plan.unchangedNames=plan.rows.length-plan.changedNames;
  return plan;
}

async function previewWardNames(db, {restore=false}={}) {
  const meta=await metadata(db), saved=new Map(meta.backups.map(row=>[String(row.ward_id),row]));
  const plan={operation:restore?'RESTORE_NAMES':'COMBINE_NAMES',separator:' + ',valid:true,issues:[],rows:[]};
  const add = (type,row,detail) => plan.issues.push({type,ward_id:row.ward_id,detail});
  for (const ward of meta.rows) {
    const old=saved.get(String(ward.ward_id));
    const row={ward_id:ward.ward_id,zone_id:ward.zone_id,current_sector_id:ward.sector_id,current_name:ward.ward_name,
      sector_id:ward.sector_id ?? ward.saved_sector_id ?? null,sector_name:ward.sector_name ?? null,
      original_name:old?.original_name ?? ward.ward_name,proposed_name:ward.ward_name,action:'keep_no_parent'};
    plan.rows.push(row);
    if(ward.valid_zone_id==null||ward.valid_city_id==null){add('invalid_geography',row,'Ward needs a valid direct Zone and City');continue;}
    if(ward.sector_id!=null && ward.saved_zone_id!=null &&
      (ward.sector_id!==ward.saved_sector_id||ward.zone_id!==ward.saved_zone_id)){
      add('conflicting_parent_backup',row,'Current Sector/Zone conflicts with the frozen parent mapping');continue;
    }
    if(old&&(ward.saved_zone_id==null||old.zone_id!==ward.saved_zone_id||old.sector_id!==ward.saved_sector_id)){
      add('inconsistent_name_parent_backup',row,'Saved original name and frozen Sector/Zone mapping disagree or the parent backup is missing');continue;
    }
    if (restore) {
      if (!old?.active) {row.action='keep';continue;}
      if (ward.zone_id!==old.zone_id || ward.ward_name!==old.combined_name) {add('changed_after_migration',row,'Ward Zone/name differs from the saved combined-name state');continue;}
      row.sector_id=old.sector_id;row.sector_name=old.sector_name;
      row.proposed_name=old.original_name;row.action='restore';continue;
    }
    if (old) {
      if (ward.zone_id!==old.zone_id || ward.ward_name!==(old.active?old.combined_name:old.original_name)) {
        add('changed_after_migration',row,'Ward Zone/name differs from the saved name state; do not overwrite HR edits');continue;
      }
      row.sector_id=old.sector_id;row.sector_name=old.sector_name;
      row.proposed_name=old.combined_name;row.action=old.active?'already_applied':'rename';continue;
    }
    if (ward.saved_zone_id!=null && ward.saved_zone_id!==ward.zone_id && ward.sector_id==null) {
      add('changed_parent_zone',row,'Saved Sector parent belongs to a different Zone');continue;
    }
    if (row.sector_id==null) continue;
    if (ward.parent_id==null || ward.parent_zone_id!==ward.zone_id) {add('invalid_parent',row,'Sector is missing or belongs to a different Zone');continue;}
    const parent=clean(ward.sector_name), child=clean(ward.ward_name);
    if (!parent || !child) {add('blank_name',row,'Both Sector and Ward names are required for combining');continue;}
    if (labelKey(child)===labelKey(parent) || labelKey(child).startsWith(labelKey(parent)+'+')) {row.action='keep_already_combined';continue;}
    row.proposed_name=parent+' + '+child;row.action='rename';
  }
  for (const old of meta.backups.filter(row=>row.active)) if (!meta.rows.some(row=>String(row.ward_id)===String(old.ward_id)))
    plan.issues.push({type:'missing_saved_ward',ward_id:old.ward_id,detail:'A renamed Ward was removed; review its saved mapping'});
  return validateNames(plan,meta);
}

function assertValidNamePlan(plan) {
  if (!plan.valid) {
    const error=new Error(`Ward name preview has ${plan.issues.length} issue(s); review names before migration`);
    error.details=plan.issues;throw error;
  }
}

// Only these exact IDs/names are permitted to differ in the preservation check.
const nameOverrides = plan => plan.rows.filter(row=>row.action==='rename'||row.action==='restore')
  .map(row=>({ward_id:row.ward_id,ward_name:row.proposed_name}));

async function applyWardNamePlan(db,plan) {
  assertValidNamePlan(plan);
  const changes=plan.rows.filter(row=>row.action==='rename'||row.action==='restore');
  if (!changes.length) return {changed:0};
  if (plan.operation==='COMBINE_NAMES') {
    await db.query(`CREATE TABLE IF NOT EXISTS ${backupTable} (
      ward_id INTEGER PRIMARY KEY,zone_id INTEGER NOT NULL,sector_id INTEGER,sector_name TEXT,
      original_name TEXT NOT NULL,combined_name TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),restored_at TIMESTAMPTZ)`);
  }
  await db.query(`LOCK TABLE ${backupTable} IN SHARE ROW EXCLUSIVE MODE`);
  if((await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='${backupTable}'::regclass AND NOT tgisinternal AND tgenabled<>'D'`)).rows.length)
    throw Error('Review enabled Ward name backup triggers before changing saved name state');
  if (plan.operation==='COMBINE_NAMES') {
    await db.query(`INSERT INTO ${backupTable}(ward_id,zone_id,sector_id,sector_name,original_name,combined_name)
      SELECT ward_id,zone_id,sector_id,sector_name,original_name,proposed_name FROM jsonb_to_recordset($1::jsonb)
      AS p(ward_id int,zone_id int,sector_id int,sector_name text,original_name text,proposed_name text)
      ON CONFLICT(ward_id) DO NOTHING`,[JSON.stringify(changes)]);
  }
  const updated=await db.query(`UPDATE wards w SET ward_name=p.proposed_name FROM jsonb_to_recordset($1::jsonb)
    AS p(ward_id int,zone_id int,current_sector_id int,current_name text,proposed_name text)
    WHERE w.ward_id=p.ward_id AND w.zone_id=p.zone_id AND w.ward_name=p.current_name
    AND w.sector_id IS NOT DISTINCT FROM p.current_sector_id RETURNING w.ward_id`,[JSON.stringify(changes)]);
  if (updated.rows.length!==changes.length) throw Error('Ward name state changed since preview; roll back');
  await db.query(plan.operation==='RESTORE_NAMES'
    ? `UPDATE ${backupTable} SET active=FALSE,restored_at=clock_timestamp() WHERE ward_id=ANY($1::int[])`
    : `UPDATE ${backupTable} SET active=TRUE,applied_at=clock_timestamp(),restored_at=NULL WHERE ward_id=ANY($1::int[])`,[changes.map(row=>row.ward_id)]);
  const saved=(await db.query(`SELECT ward_id,zone_id,sector_id,sector_name,original_name,combined_name,active FROM ${backupTable} WHERE ward_id=ANY($1::int[]) ORDER BY ward_id`,[changes.map(row=>row.ward_id)])).rows;
  const expected=changes.map(row=>({ward_id:row.ward_id,zone_id:row.zone_id,sector_id:row.sector_id,sector_name:row.sector_name,
    original_name:row.original_name,combined_name:plan.operation==='RESTORE_NAMES'?row.current_name:row.proposed_name,
    active:plan.operation!=='RESTORE_NAMES'})).sort((a,b)=>a.ward_id-b.ward_id);
  if(JSON.stringify(saved)!==JSON.stringify(expected))throw Error('Saved Ward name state does not match the approved plan; roll back');
  return {changed:changes.length};
}

// Scope is supplied by the already-filtered current location directory. Aliases
// stop applying if HR later changes the saved Zone/name; ambiguous names fail the
// import's normal single-location check. Rollback workbooks remain readable too.
async function attachWardImportAliases(db,locations) {
  if (!locations.length || !await exists(db,backupTable)) return locations;
  const rows=(await db.query(`SELECT b.ward_id,
    CASE WHEN b.active THEN b.original_name ELSE b.combined_name END AS alias
    FROM ${backupTable} b JOIN wards w USING(ward_id)
    WHERE b.ward_id=ANY($1::int[]) AND b.zone_id=w.zone_id
    AND w.ward_name=CASE WHEN b.active THEN b.combined_name ELSE b.original_name END`,[locations.map(row=>row.kothi_id)])).rows;
  const aliases=new Map(rows.map(row=>[String(row.ward_id),[row.alias]]));
  return locations.map(row=>aliases.has(String(row.kothi_id))?{...row,kothi_aliases:aliases.get(String(row.kothi_id))}:row);
}
module.exports={previewWardNames,assertValidNamePlan,nameOverrides,applyWardNamePlan,attachWardImportAliases};
