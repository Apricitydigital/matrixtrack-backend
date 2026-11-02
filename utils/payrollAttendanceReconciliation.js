'use strict';
const {createHash}=require('node:crypto');
const datasets={regular:{table:'attendance',person:'emp_id',in:'punch_in_time',out:'punch_out_time'},self:{table:'self_attendance_records',person:'self_attendance_id',in:'punch_in',out:'punch_out'}};
// These are raw attendance inputs, not a replacement salary/payable-day policy.
// Hashing all original row fields also catches same-total date/status changes.
async function capturePayrollInputs(client){
 const result={};
 for(const [kind,d]of Object.entries(datasets))result[kind]=(await client.query(`WITH input AS (
  SELECT ${d.person}::text AS employee_id,to_char(date::date,'YYYY-MM') AS month,md5(to_jsonb(t)::text) AS row_hash,
   ${d.in} IS NOT NULL AS has_in,${d.out} IS NOT NULL AS has_out,
   CASE WHEN ${d.in} IS NOT NULL AND ${d.out} IS NOT NULL THEN EXTRACT(EPOCH FROM (${d.out}-${d.in})) ELSE NULL END AS elapsed_seconds
  FROM public.${d.table} t)
 SELECT employee_id,month,count(*)::text AS records,
  count(*) FILTER(WHERE has_in)::text AS punch_ins,count(*) FILTER(WHERE has_out)::text AS punch_outs,
  count(*) FILTER(WHERE has_in AND NOT has_out)::text AS open_punches,
  COALESCE(sum(elapsed_seconds),0)::text AS raw_elapsed_seconds,
  count(*) FILTER(WHERE elapsed_seconds<0)::text AS negative_duration_rows,
  md5(COALESCE(string_agg(row_hash,'' ORDER BY row_hash),'')) AS rows_digest
 FROM input GROUP BY employee_id,month ORDER BY employee_id NULLS FIRST,month NULLS FIRST`)).rows;
 return result;
}
function summarizePayrollInputs(capture){
 return Object.fromEntries(Object.entries(capture).map(([kind,rows])=>[kind,{
  employees:new Set(rows.map(row=>row.employee_id)).size,employeeMonths:rows.length,
  records:rows.reduce((n,row)=>n+BigInt(row.records),0n).toString(),
  openPunches:rows.reduce((n,row)=>n+BigInt(row.open_punches),0n).toString(),
  checksum:createHash('sha256').update(JSON.stringify(rows)).digest('hex')
 }]));
}
function assertPayrollInputsUnchanged(before,after){
 const differences=[];
 for(const kind of Object.keys(datasets)){
  const key=row=>JSON.stringify([row.employee_id,row.month]);
  const old=new Map((before[kind]||[]).map(row=>[key(row),row])),current=new Map((after[kind]||[]).map(row=>[key(row),row]));
  for(const id of new Set([...old.keys(),...current.keys()]))if(JSON.stringify(old.get(id))!==JSON.stringify(current.get(id)))
   differences.push({kind,employee_id:(old.get(id)||current.get(id)).employee_id,month:(old.get(id)||current.get(id)).month});
 }
 if(differences.length){const error=new Error('Payroll attendance inputs changed for '+differences.length+' employee/month group(s); roll back');error.details=differences.slice(0,100);throw error;}
 return {verified:true,before:summarizePayrollInputs(before),after:summarizePayrollInputs(after)};
}
module.exports={capturePayrollInputs,summarizePayrollInputs,assertPayrollInputsUnchanged};
