const {fingerprint}=require('./workforceReview');
const reject=message=>{throw Object.assign(new Error(message),{status:409});};
async function weeklyOffPlan(client,kind,ids,selectedId){
 if(kind!=='professional')return null;
 const available=(await client.query("SELECT to_regclass('professional_week_off') IS NOT NULL AS available")).rows[0]?.available;
 if(!available)return null;
 const rows=(await client.query('SELECT to_jsonb(w) AS row FROM professional_week_off w WHERE professional_id::text=ANY($1::text[]) ORDER BY professional_id FOR UPDATE',[ids])).rows.map(item=>item.row);
 // The first ID is always the chosen main profile. A missing schedule means
 // no weekly off; a duplicate's schedule must never fill or overwrite it.
 selectedId=ids[0];
 const hasVersions=(await client.query("SELECT to_regclass('professional_week_off_versions') IS NOT NULL AS available")).rows[0]?.available;
 const historyFunction=(await client.query("SELECT CASE WHEN to_regprocedure('capture_professional_week_off()') IS NULL THEN true ELSE position('matrixtrack.merge_replay' IN pg_get_functiondef(to_regprocedure('capture_professional_week_off()')))>0 END AS ready")).rows[0]?.ready;
 if(!historyFunction)reject('Weekly-off recovery requires the workforce schema upgrade before this merge. No records were changed.');
 const versions=hasVersions?(await client.query('SELECT to_jsonb(v) AS row FROM professional_week_off_versions v WHERE professional_id::text=ANY($1::text[]) ORDER BY id FOR UPDATE',[ids])).rows.map(item=>item.row):[];
 return {selectedId,discardIds:ids.slice(1),hasVersions,days:rows.find(row=>row.professional_id===selectedId)?.week_off_days || [],fingerprint:fingerprint({rows,versions,selectedId})};
}
async function consolidateWeeklyOff(client,plan){
 if(!plan)return;
 // The chosen account's complete dated schedule is retained, rather than
 // combining incompatible histories. All removed rows are recovery-journaled.
 if(plan.hasVersions)await client.query('DELETE FROM professional_week_off_versions WHERE professional_id::text=ANY($1::text[])',[plan.discardIds]);
 await client.query('DELETE FROM professional_week_off WHERE professional_id::text=ANY($1::text[])',[plan.discardIds]);
}
module.exports={weeklyOffPlan,consolidateWeeklyOff};
