const crypto=require('node:crypto');
const {capabilities}=require('./professionalPunchCutoff');
const faces=require('./supervisorFaceIndex');
const {modeJoin,modeFields,regularEmployee}=require('./employeeAttendanceMode');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const brokenConnection=error=>error?.message==='Query read timeout'||['ECONNRESET','EPIPE','57P01','57P02','57P03'].includes(error?.code)||String(error?.code||'').startsWith('08');
const positive=value=>/^[1-9]\d*$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)<=2147483647;
async function context(db,actor,site){
 if(!positive(site))fail('Select a kothi.');
 if(!(await capabilities(db,actor)).pm)fail('Project Head access required.',403);
 const row=(await db.query(`SELECT w.ward_id,w.ward_name,z.city_id,p.full_name AS actor_name FROM professional_site_access s
  JOIN professional_employees p ON p.id=s.professional_id AND p.is_active=TRUE JOIN wards w ON w.ward_id=s.kothi_id
  LEFT JOIN zones z ON z.zone_id=w.zone_id WHERE s.professional_id=$1 AND s.kothi_id=$2`,[actor,site])).rows[0];
 if(!row)fail('Kothi is outside your assigned access.',403);return row;
}
async function roster(db,site){
 return (await db.query(`SELECT e.emp_id,e.name,e.emp_code,e.ward_id,e.face_embedding,saf.face_id,saf.version,saf.photo_key,saf.source_ref,
  ${modeFields},COALESCE(sc.recapture_required,FALSE) AS recapture_required,sc.reason AS recapture_reason,a.punch_in_time,a.punch_out_time,a.register_status,
  CASE WHEN a.supervisor_in_by IS NOT NULL OR a.supervisor_out_by IS NOT NULL THEN 'supervisor' WHEN a.register_status IS NOT NULL THEN 'register' ELSE 'punch' END AS attendance_source
  FROM employee e ${modeJoin}
  LEFT JOIN supervisor_attendance_face_checks sc ON sc.emp_id=e.emp_id AND sc.site_id=e.ward_id AND sc.source_ref=e.face_embedding
  LEFT JOIN LATERAL(SELECT aa.* FROM attendance aa WHERE aa.emp_id=e.emp_id AND
   (aa.date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date OR (aa.date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date-1 AND aa.punch_in_time IS NOT NULL AND aa.punch_out_time IS NULL))
   ORDER BY (aa.punch_in_time IS NOT NULL AND aa.punch_out_time IS NULL) DESC,aa.date DESC LIMIT 1) a ON TRUE
  WHERE e.ward_id=$1 AND ${regularEmployee} ORDER BY e.name,e.emp_id`,[site])).rows;
}
async function enroll(pool,actor,body,file){
 const site=Number(body.site_id),emp=Number(body.emp_id);if(!positive(emp))fail('Select an employee.');
 const db=await pool.connect();let uploaded=null,indexed=null,old=null,committed=false,commitAttempted=false,locked=false,releaseError;
 try{
  const geo=await context(db,actor,site);
  // One enrollment at a time per kothi prevents simultaneous duplicate-face identities.
  locked=(await db.query("SELECT pg_try_advisory_lock(hashtext('supervisor-face-enroll:' || $1::text)) AS locked",[site])).rows[0].locked;
  if(!locked)fail('Another face is being stored for this kothi. Retry shortly.',409);
  const person=(await roster(db,site)).find(p=>p.emp_id===emp);
  if(!person)fail('Employee is unavailable at this kothi.',404);
  if(person.attendance_mode==='register')fail('This employee uses Register Attendance.',409);
  if(person.supervisor_face_ready)fail('Face is already stored.',409);
  if(file&&person.face_embedding&&!person.recapture_required)fail('The saved photo is being checked. Refresh and retry.',409);
  if(file&&!(body.consent_given===true||body.consent_given==='true'))fail('Confirm the employee agreed to face registration.');
  if(!file&&!person.face_embedding)fail('Capture the employee’s face.');
  const reuse=!file&&person.photo_key&&person.source_ref===person.face_embedding;
  const image=await faces.normalize(file?.buffer||await faces.readPhoto(reuse?person.photo_key:person.face_embedding));
  indexed=await faces.indexFace(site,emp,image,geo.city_id);
  const key=reuse?person.photo_key:await faces.putPhoto(image,`faces/${site}/${emp}`);
  if(!reuse)uploaded=key;
  const sourceRef=person.face_embedding||key;
  await db.query('BEGIN');await context(db,actor,site);
  const current=(await db.query(`SELECT e.ward_id,e.face_embedding FROM employee e WHERE e.emp_id=$1 AND ${regularEmployee} FOR UPDATE`,[emp])).rows[0];
  if(current?.ward_id!==site||current.face_embedding!==person.face_embedding)fail('Employee details changed. Refresh and retry.',409);
  if((await roster(db,site)).find(p=>p.emp_id===emp)?.attendance_mode==='register')fail('This employee now uses Register Attendance. Refresh and retry.',409);
  old=(await db.query('SELECT * FROM supervisor_attendance_faces WHERE emp_id=$1 FOR UPDATE',[emp])).rows[0];
  if((old?.version||null)!==(person.version||null))fail('Face details changed. Refresh and retry.',409);
  // Reuse a legacy photo without modifying it; only new employees receive a face reference.
  if(!current.face_embedding)await db.query('UPDATE employee SET face_embedding=$2 WHERE emp_id=$1',[emp,key]);
  await db.query(`INSERT INTO supervisor_attendance_faces(emp_id,site_id,collection_id,face_id,photo_key,source_ref,enrolled_by,consent_recorded)
   VALUES($1,$2,$3,$4,$5,$6,$7,TRUE) ON CONFLICT(emp_id) DO UPDATE SET site_id=EXCLUDED.site_id,
    collection_id=EXCLUDED.collection_id,face_id=EXCLUDED.face_id,photo_key=EXCLUDED.photo_key,source_ref=EXCLUDED.source_ref,version=gen_random_uuid()`,
  [emp,site,indexed.collectionId,indexed.faceId,key,sourceRef,actor]);
  await db.query('DELETE FROM supervisor_attendance_face_checks WHERE emp_id=$1 AND site_id=$2',[emp,site]);
  commitAttempted=true;await db.query('COMMIT');committed=true;
  if(old&&old.face_id!==indexed.faceId&&old.collection_id===faces.collectionFor(old.site_id))await faces.discardFace(old.site_id,old.face_id);
  return {emp_id:emp,face_stored:true,supervisor_face_ready:true};
 }catch(e){if(brokenConnection(e))releaseError=e;if(!committed){if(!releaseError)await db.query('ROLLBACK').catch(()=>{});if(!commitAttempted){if(indexed)await faces.discardFace(site,indexed.faceId);if(uploaded)await faces.discardPhoto(uploaded);}}throw e;}
 finally{if(locked&&!releaseError)await db.query("SELECT pg_advisory_unlock(hashtext('supervisor-face-enroll:' || $1::text))",[site]).catch(()=>{});db.release(releaseError);}
}
async function prepareFace(pool,actor,body){
 const site=Number(body.site_id),emp=Number(body.emp_id);if(!positive(emp))fail('Select an employee.');
 await context(pool,actor,site);
 const person=(await roster(pool,site)).find(p=>p.emp_id===emp);
 if(!person)fail('Employee is unavailable at this kothi.',404);
 if(person.attendance_mode==='register'||person.supervisor_face_ready||person.recapture_required||!person.face_embedding)return person;
 try{await enroll(pool,actor,body,null);}
 catch(error){
  if(error.status!==422&&error.code!=='FACE_ALREADY_ASSIGNED')throw error;
  // Remember an unusable legacy photo once; a changed source/site is checked afresh.
  await context(pool,actor,site);
  await pool.query(`INSERT INTO supervisor_attendance_face_checks(emp_id,site_id,source_ref,reason)
   SELECT e.emp_id,e.ward_id,e.face_embedding,$4 FROM employee e WHERE e.emp_id=$1 AND e.ward_id=$2 AND e.face_embedding=$3
   ON CONFLICT(emp_id,site_id) DO UPDATE SET source_ref=EXCLUDED.source_ref,reason=EXCLUDED.reason,recapture_required=TRUE,checked_at=clock_timestamp()`,[emp,site,person.face_embedding,error.message.slice(0,250)]);
 }
 const current=(await roster(pool,site)).find(p=>p.emp_id===emp);
 if(!current)fail('Employee details changed. Refresh and retry.',409);
 return current;
}
function requestIdentity(body,file){
 const site=Number(body.site_id),group=body.group===true||body.group==='true',type=body.punch_type,emp=group?null:Number(body.emp_id);
 if(!positive(site)||(!group&&!positive(emp))||!['in','out'].includes(type)||!file?.buffer?.length)fail('Select a kothi, punch type and capture a photo.');
 const requestKey=String(body.request_key||'');if(!/^[a-zA-Z0-9_-]{12,100}$/.test(requestKey))fail('Capture reference is missing. Open the camera again.');
 const latitude=Number(body.latitude),longitude=Number(body.longitude);
 if(body.latitude==null||body.longitude==null||String(body.latitude).trim()===''||String(body.longitude).trim()===''||!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude<-90||latitude>90||longitude<-180||longitude>180)fail('Current location is required.');
 const digest=crypto.createHash('sha256').update(file.buffer).update(JSON.stringify({site,group,type,emp,latitude,longitude})).digest('hex');
 return {site,group,type,emp,requestKey,digest,latitude,longitude};
}
async function existing(db,actor,identity){
 const row=(await db.query('SELECT * FROM supervisor_attendance_captures WHERE actor_id=$1 AND request_key=$2',[actor,identity.requestKey])).rows[0];
 if(row&&row.image_digest!==identity.digest)fail('Capture reference was already used for another photo or action.',409);
 return row?.result;
}
async function punch(pool,actor,body,file){
 const identity=requestIdentity(body,file),{site,group,type,emp,requestKey,digest,latitude,longitude}=identity;
 const geo=await context(pool,actor,site),replayed=await existing(pool,actor,identity);if(replayed)return {...replayed,replayed:true};
 const people=(await roster(pool,site)).filter(p=>p.supervisor_face_ready&&(group||p.emp_id===emp)&&
  (type==='in'?p.attendance_mode!=='register':p.punch_in_time&&!p.punch_out_time&&!p.register_status));
 if(!people.length)fail(type==='in'?'No eligible stored faces at this kothi.':'No eligible open punch-ins at this kothi.',409);
 const image=await faces.normalize(file.buffer),matched=await faces.matchFaces(site,image,people,group,geo.city_id);
 let imageKey=matched.some(m=>m.employee)?await faces.putPhoto(image,`punches/${site}`):'';
 let db;try{db=await pool.connect();}catch(error){if(imageKey)await faces.discardPhoto(imageKey);throw error;}let committed=false,commitAttempted=false,releaseError;
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='4s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`supervisor-capture:${actor}:${requestKey}`]);
  await context(db,actor,site);const again=await existing(db,actor,identity);
  if(again){await db.query('COMMIT');committed=true;if(imageKey)await faces.discardPhoto(imageKey);return {...again,replayed:true};}
  const capture=(await db.query(`INSERT INTO supervisor_attendance_captures(actor_id,site_id,request_key,image_digest,punch_type,group_capture,image_key,result)
   VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb) RETURNING id`,[actor,site,requestKey,digest,type,group,imageKey])).rows[0];
  const results=matched.map(m=>({face:m.face,emp_id:m.employee?.emp_id,name:m.employee?.name,similarity:m.similarity,status:'skipped',reason:m.reason}));
  // A group capture has one IST timestamp/date even if row locks cross midnight.
  const captured=(await db.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::text AS punch_time")).rows[0].punch_time;
  const date=captured.slice(0,10);
  // Stable employee lock order also makes simultaneous group captures safe.
  for(const match of matched.filter(m=>m.employee).sort((a,b)=>a.employee.emp_id-b.employee.emp_id)){
   const row=results.find(r=>r.face===match.face),person=match.employee;
   const live=(await db.query(`SELECT e.*,saf.version,saf.site_id AS face_site,saf.source_ref FROM employee e
    JOIN supervisor_attendance_faces saf ON saf.emp_id=e.emp_id WHERE e.emp_id=$1 AND ${regularEmployee} FOR UPDATE OF e,saf`,[person.emp_id])).rows[0];
   if(!live||live.ward_id!==site||live.face_site!==site||live.version!==person.version||live.source_ref!==live.face_embedding){row.reason='Employee or face changed; refresh and retry';continue;}
   const activeRegister=(await db.query("SELECT 1 FROM register_attendance_requests WHERE emp_id=$1 AND site_id=$2 AND status='approved' AND $3::date BETWEEN starts_on AND ends_on LIMIT 1",[person.emp_id,site,date])).rows.length;
   if(type==='in'&&activeRegister){row.reason='Uses Register Attendance';continue;}
   const open=(await db.query(`SELECT * FROM attendance WHERE emp_id=$1 AND date BETWEEN $2::date-1 AND $2::date
    AND punch_in_time IS NOT NULL AND punch_out_time IS NULL ORDER BY date DESC LIMIT 1 FOR UPDATE`,[person.emp_id,date])).rows[0];
   if(type==='in'&&open){row.reason='Already punched in';continue;}
   if(type==='out'&&(!open||open.ward_id!==site)){row.reason='No open punch-in at this kothi';continue;}
   let attendance=open;
   if(type==='in'){
    await db.query('INSERT INTO attendance(emp_id,date,ward_id) VALUES($1,$2::date,$3) ON CONFLICT(emp_id,date) DO NOTHING',[person.emp_id,date,site]);
    attendance=(await db.query('SELECT * FROM attendance WHERE emp_id=$1 AND date=$2::date FOR UPDATE',[person.emp_id,date])).rows[0];
    if(attendance.punch_in_time||attendance.punch_out_time||attendance.mid_shift_punch_in_time||attendance.leave_type||attendance.register_status){row.reason='Attendance already marked';continue;}
   }
   if(attendance.register_status||attendance.leave_type){row.reason='Register attendance or leave already marked';continue;}
   const result=(await db.query(`UPDATE attendance SET punch_${type}_time=$8::timestamp,
    ${type==='in'?'latitude_in':'latitude_out'}=$2,${type==='in'?'longitude_in':'longitude_out'}=$3,
    ${type==='in'?'in_address':'out_address'}='Supervisor Attendance',punch_${type}_image=$4,
    supervisor_${type}_by=$5,supervisor_${type}_name=$6,supervisor_${type}_capture=$7
    WHERE attendance_id=$1 AND punch_${type}_time IS NULL RETURNING attendance_id`,
   [attendance.attendance_id,latitude,longitude,null,actor,geo.actor_name,capture.id,captured])).rows[0];
   if(result){row.status='marked';row.reason=undefined;row.attendance_id=result.attendance_id;row.punch_type=type;}
   else row.reason='Attendance just changed; refresh';
  }
  const response={capture_id:capture.id,punch_type:type,marked:results.filter(r=>r.status==='marked').length,results};
  await db.query('UPDATE supervisor_attendance_captures SET result=$2 WHERE id=$1',[capture.id,JSON.stringify(response)]);
  commitAttempted=true;await db.query('COMMIT');committed=true;return response;
 }catch(e){if(brokenConnection(e))releaseError=e;if(!committed){if(!releaseError)await db.query('ROLLBACK').catch(()=>{});if(imageKey&&!commitAttempted)await faces.discardPhoto(imageKey);}throw e;}
 finally{db.release(releaseError);}
}
module.exports={context,roster,enroll,prepareFace,punch,requestIdentity};
