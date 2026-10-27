const {withAttendanceIdentity}=require('./professionalAttendanceIdentity');
const {buildVisibilityScope}=require('./professionalAccess');

function dateRange(input={}) {
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
 const start=input.startDate || input.date || today,end=input.endDate || start;
 const valid=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
 if(!valid(start) || !valid(end) || start>end || (Date.parse(end)-Date.parse(start))/86400000>=366)throw Object.assign(Error('Choose a valid date range of up to 366 days.'),{status:400});
 return {start,end};
}
function reportQuery(kind,{cities,sites,user,cityScope,start,end,zoneId=null,sectorId=null}) {
 const professional=kind==='professional';
 const visibility=professional?buildVisibilityScope({...user,role:['super_admin','superadmin'].includes(user.role)?'admin':user.role},cityScope,'geo'):{cte:'',whereClause:'true',params:[]};
 const params=[...visibility.params,cities,sites,start,end,zoneId,sectorId];
 const offset=visibility.params.length,city=`$${offset+1}::int[]`,site=`$${offset+2}::int[]`,from=`$${offset+3}::date`,to=`$${offset+4}::date`;
 const zone=`$${offset+5}::int`,sector=`$${offset+6}::int`;
 const allowed=(cityExpr,siteExpr,zoneExpr,sectorExpr)=>`(${city} IS NULL OR ${cityExpr}=ANY(${city})) AND (${site} IS NULL OR ${siteExpr}=ANY(${site})) AND (${zone} IS NULL OR ${zoneExpr}=${zone}) AND (${sector} IS NULL OR ${sectorExpr}=${sector})`;
 const currentAllowed=`(${allowed('c.city_id','w.ward_id','z.zone_id','w.sector_id')}) AND (${visibility.whereClause.replace(/\bgeo\./g,'pe.')})`;
 const location=(cityExpr,zoneExpr,sectorExpr,siteExpr,cityName,zoneName,siteName)=>`jsonb_build_object('city_id',${cityExpr},'zone_id',${zoneExpr},'sector_id',${sectorExpr},'ward_id',${siteExpr},'city',${cityName},'zone',${zoneName},'ward',${siteName})`;
 const fields=professional?`'professional:'||pe.id::text AS emp_id,pe.id::text AS source_employee_id,pe.full_name AS name,pe.emp_code,pe.mobile AS phone,
  pe.city_id,pe.zone_id,COALESCE(w.sector_id,pe.ward_id) AS sector_id,w.ward_id,
  pe.selfie_url IS NOT NULL AS face_registered,COALESCE(roles.department,'Professional') AS department,roles.designation,
  COALESCE(roles.department_ids,ARRAY[(SELECT department_id FROM department WHERE lower(trim(department_name))='professional' ORDER BY department_id LIMIT 1)]) AS department_ids,roles.designation_ids`
 :`e.emp_id::text AS emp_id,e.emp_id::text AS source_employee_id,e.name,e.emp_code,e.phone,c.city_id,z.zone_id,w.sector_id,w.ward_id,
  e.face_embedding IS NOT NULL AS face_registered,dept.department_name AS department,des.designation_name AS designation,ARRAY[dept.department_id] AS department_ids,ARRAY[des.designation_id] AS designation_ids`;
 const directory=professional?`professional_employees pe LEFT JOIN wards w ON w.ward_id=COALESCE(pe.kothi_id,pe.ward_id)
  LEFT JOIN zones z ON z.zone_id=pe.zone_id LEFT JOIN cities c ON c.city_id=pe.city_id
  LEFT JOIN LATERAL(SELECT string_agg(DISTINCT d.department_name,', ' ORDER BY d.department_name) AS department,
   string_agg(DISTINCT des.designation_name,', ' ORDER BY des.designation_name) AS designation,
   array_agg(DISTINCT d.department_id) AS department_ids,array_agg(DISTINCT des.designation_id) AS designation_ids
   FROM professional_designation_assignments da JOIN designation des ON des.designation_id=da.designation_id
   LEFT JOIN department d ON d.department_id=des.department_id WHERE da.professional_id=pe.id) roles ON true`
 :`employee e LEFT JOIN wards w ON w.ward_id=e.ward_id LEFT JOIN zones z ON z.zone_id=w.zone_id LEFT JOIN cities c ON c.city_id=z.city_id
  LEFT JOIN designation des ON des.designation_id=e.designation_id LEFT JOIN department dept ON dept.department_id=des.department_id`;
 const entries=professional?`SELECT jsonb_build_object('record',to_jsonb(a),'date',a.date::text,'location',${location('geo.city_id','geo.zone_id','geo.ward_id','geo.kothi_id','ac.city_name','az.zone_name',"COALESCE(aw.ward_name,'Site not recorded')")},'leave_type',
   (SELECT l.leave_type FROM professional_leave_requests l WHERE l.professional_id=pe.id AND l.requested_date=a.date AND l.status='approved' ORDER BY l.id LIMIT 1)) AS entry
   FROM professional_attendance a
   CROSS JOIN LATERAL(SELECT COALESCE(a.city_id,pe.city_id) AS city_id,COALESCE(a.zone_id,pe.zone_id) AS zone_id,
    COALESCE(a.ward_id,pe.ward_id) AS ward_id,(to_jsonb(a)->>'kothi_id')::int AS kothi_id) geo
   LEFT JOIN wards aw ON aw.ward_id=geo.kothi_id LEFT JOIN zones az ON az.zone_id=geo.zone_id LEFT JOIN cities ac ON ac.city_id=geo.city_id
   WHERE a.professional_id=pe.id AND a.date BETWEEN ${from} AND ${to}
   AND ${allowed('geo.city_id','geo.kothi_id','geo.zone_id','geo.ward_id')} AND (${visibility.whereClause})
   UNION ALL SELECT jsonb_build_object('record',NULL,'date',l.requested_date::text,'leave_type',l.leave_type)
   FROM professional_leave_requests l WHERE l.professional_id=pe.id AND l.status='approved' AND l.requested_date BETWEEN ${from} AND ${to}
   AND (${currentAllowed}) AND NOT EXISTS(SELECT 1 FROM professional_attendance a WHERE a.professional_id=pe.id AND a.date=l.requested_date)`
 :`SELECT jsonb_build_object('record',to_jsonb(a)||jsonb_build_object('punched_in_by',ui.name,'punched_out_by',uo.name,'mid_shift_punched_in_by',um.name),'date',a.date::date::text,'location',${location('ac.city_id','az.zone_id','aw.sector_id','aw.ward_id','ac.city_name','az.zone_name','aw.ward_name')},'leave_type',a.leave_type) AS entry
   FROM attendance a LEFT JOIN wards aw ON aw.ward_id=a.ward_id LEFT JOIN zones az ON az.zone_id=aw.zone_id LEFT JOIN cities ac ON ac.city_id=az.city_id
   LEFT JOIN users ui ON ui.user_id=a.punched_in_by LEFT JOIN users uo ON uo.user_id=a.punched_out_by LEFT JOIN users um ON um.user_id=a.mid_shift_punched_in_by
   WHERE a.emp_id=e.emp_id AND a.date::date BETWEEN ${from} AND ${to}
   AND ${allowed('ac.city_id','aw.ward_id','az.zone_id','aw.sector_id')}`;
 const sql=`${visibility.cte} SELECT ${fields},'${kind}' AS employee_kind,c.city_name AS city,z.zone_name AS zone,w.ward_name AS ward,
  (${currentAllowed}) AS current_assignment_visible,COALESCE(data.entries,'[]'::jsonb) AS entries FROM ${directory}
  LEFT JOIN LATERAL(SELECT jsonb_agg(entry ORDER BY entry->>'date') AS entries FROM (SELECT entry FROM (${entries}) raw_events LIMIT 50001) events) data ON true
  WHERE ((${currentAllowed}) OR data.entries IS NOT NULL)
  ${professional?`AND (pe.is_active=true OR data.entries IS NOT NULL)`:''}
  ORDER BY ${professional?'pe.full_name,pe.id':'e.name,e.emp_id'}`;
 return {sql:professional?withAttendanceIdentity(sql,params):sql,params};
}
const time=(value,professional=false)=>{
 if(!value)return null;
 if(professional)return new Date(value).toLocaleTimeString('en-GB',{timeZone:'Asia/Kolkata',hour12:false});
 return String(value).match(/[T ](\d{2}:\d{2}:\d{2})/)?.[1] || String(value).slice(0,8);
};
function normalizeReport(rows) {
 const employees=[],records=[];
 for(const {entries,current_assignment_visible,...employee} of rows) {
  const professional=employee.employee_kind==='professional';
  const currentLocation=Object.fromEntries(['city_id','zone_id','sector_id','ward_id','city','zone','ward'].map(key=>[key,employee[key]]));
  const locations=[...new Map([...(current_assignment_visible?[currentLocation]:[]),...entries.map(entry=>entry.location).filter(Boolean)].map(loc=>[JSON.stringify(loc),loc])).values()];
  const person={...employee,...(!current_assignment_visible && locations[0]?locations[0]:{}),report_locations:locations,employee_type:professional?'Professional':'Regular'};
  employees.push(person);
  for(const entry of entries) {
   const a=entry.record || {},date=entry.date.split('-').reverse().join('-');
   const status=a.punch_approval_status;
   const accepted=!professional || !status || status==='accepted';
   const punchIn=accepted?time(professional?a.punch_in:a.punch_in_time,professional):null;
   const out=accepted?time(professional?a.punch_out:a.punch_out_time,professional):null;
   records.push({...person,...entry.location,report_locations:undefined,historical_site_unknown:professional && Boolean(entry.record) && !entry.location?.ward_id,attendance_id:professional?`professional:${a.id || entry.date}`:a.attendance_id,
    source_attendance_id:professional?a.id:a.attendance_id,date,contact_no:person.phone,
    punch_in:punchIn,punch_out:out,mid_shift_punch_in:professional?null:time(a.mid_shift_punch_in_time,true),
    register_status:a.register_status,register_request_id:a.register_request_id,register_marked_by:a.register_marked_by,
    register_marked_by_name:a.register_marked_by_name,register_marked_at:a.register_marked_at,
    attendance_source:a.register_status?'register':a.supervisor_in_by||a.supervisor_out_by?'supervisor':'punch',
    supervisor_in_name:a.supervisor_in_name,supervisor_out_name:a.supervisor_out_name,
    supervisor_in_capture:a.supervisor_in_capture,supervisor_out_capture:a.supervisor_out_capture,
    leave_type:professional && punchIn?null:entry.leave_type,
    attendance_status:professional && status?.startsWith('pending_')?'in-consideration':status==='rejected'?'punch-not-accepted':null,
    punch_approval_status:status,attempted_punch_in:a.attempted_punch_in,
    is_auto_punch_out:a.auto_punched_out===true,in_address:a.in_address,out_address:a.out_address,
    latitude_in:professional?a.punch_in_latitude:a.latitude_in,longitude_in:professional?a.punch_in_longitude:a.longitude_in,
    latitude_out:professional?a.punch_out_latitude:a.latitude_out,longitude_out:professional?a.punch_out_longitude:a.longitude_out,
    latitude_mid_in:a.latitude_mid_in,longitude_mid_in:a.longitude_mid_in,mid_in_address:a.mid_in_address,
    punch_in_image:professional?a.punch_in_photo_url:a.punch_in_image,punch_out_image:professional?a.punch_out_photo_url:a.punch_out_image,
    mid_shift_punch_in_image:a.mid_shift_punch_in_image,
    punched_in_by:professional?(punchIn?person.name:null):(a.supervisor_in_name||a.punched_in_by),
    punched_out_by:professional?(out?person.name:null):(a.supervisor_out_name||a.punched_out_by),mid_shift_punched_in_by:a.mid_shift_punched_in_by,
   });
  }
 }
 records.sort((a,b)=>a.date.split('-').reverse().join('-').localeCompare(b.date.split('-').reverse().join('-')) || (a.punch_in || '99').localeCompare(b.punch_in || '99') || a.name.localeCompare(b.name));
 return {employees,records};
}
module.exports={dateRange,reportQuery,normalizeReport};
