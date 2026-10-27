// Called only after the report has enforced its city/site permissions.
async function signSupervisorAttendancePhotos(records,pool,sign){
 const ids=[...new Set(records.flatMap(row=>[row.supervisor_in_capture,row.supervisor_out_capture]).filter(Boolean))];
 for(let offset=0;offset<ids.length;offset+=200){
  const photos=(await pool.query('SELECT id,image_key FROM supervisor_attendance_captures WHERE id=ANY($1::uuid[])',[ids.slice(offset,offset+200)])).rows;
  const urls=new Map();
  for(let i=0;i<photos.length;i+=10)await Promise.all(photos.slice(i,i+10).map(async photo=>{if(photo.image_key)urls.set(photo.id,await sign(photo.image_key,900));}));
  for(const row of records){
   if(urls.has(row.supervisor_in_capture))row.punch_in_image_url=urls.get(row.supervisor_in_capture);
   if(urls.has(row.supervisor_out_capture))row.punch_out_image_url=urls.get(row.supervisor_out_capture);
  }
 }
}
module.exports={signSupervisorAttendancePhotos};
