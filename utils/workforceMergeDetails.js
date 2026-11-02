async function mergeDetails(client,profiles){
 const details=new Map();
 for(const kind of ['regular','self_attendance']){
  const ids=profiles.filter(row=>row.kind===kind).map(row=>row.id);
  if(!ids.length)continue;
  const table=kind==='regular'?'attendance':'self_attendance_records';
  const key=kind==='regular'?'emp_id':'self_attendance_id';
  const punch=kind==='regular'?'punch_in_time':'punch_in';
  const {rows}=await client.query(`SELECT ${key}::text AS id,MAX(${punch}) AS last_punch_in,
   COUNT(DISTINCT date::date) FILTER(WHERE ${punch} IS NOT NULL)::int AS present_days
   FROM ${table} WHERE ${key}::text=ANY($1::text[]) GROUP BY ${key}`,[ids]);
  for(const row of rows)details.set(`${kind}:${row.id}`,row);
 }
 const days=new Map();
 if((await client.query("SELECT to_regclass('self_attendance_week_off') IS NOT NULL AS available")).rows[0]?.available){
  const ids=profiles.filter(row=>row.kind==='self_attendance').map(row=>row.id);
  if(ids.length)for(const row of (await client.query('SELECT self_attendance_id::text AS id,week_off_days FROM self_attendance_week_off WHERE self_attendance_id::text=ANY($1::text[])',[ids])).rows)days.set(row.id,row.week_off_days);
 }
 return profiles.map(profile=>({...profile,last_punch_in:details.get(`${profile.kind}:${profile.id}`)?.last_punch_in || null,present_days:details.get(`${profile.kind}:${profile.id}`)?.present_days || 0,...(profile.kind==='self_attendance'?{week_off_days:days.get(profile.id)||[]}: {})}));
}
module.exports={mergeDetails};
