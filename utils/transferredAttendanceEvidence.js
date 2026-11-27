// Only authorized administrative/report endpoints call this projection. Private
// group-photo keys stay out of employee punch-photo fields and public readers.
function transferredAttendanceEvidence(row){
 const meta=row.transfer_original;
 if(!meta)return row;
 const {transfer_original,...plain}=row;
 if(meta.kind!=='regular')return plain;
 const original=meta.record||{},evidence=meta.evidence||{};
 return {...plain,
  punch_in_photo_url:row.punch_in_photo_url||evidence.in?.image_key||null,
  punch_out_photo_url:row.punch_out_photo_url||evidence.out?.image_key||null,
  supervisor_in_capture:original.supervisor_in_capture||null,supervisor_out_capture:original.supervisor_out_capture||null,
  supervisor_in_by:original.supervisor_in_by||evidence.in?.actor_id||null,supervisor_out_by:original.supervisor_out_by||evidence.out?.actor_id||null,
  supervisor_in_name:original.supervisor_in_name||evidence.in?.actor_name||null,
  supervisor_out_name:original.supervisor_out_name||evidence.out?.actor_name||null,
  mid_shift_punch_in_time:original.mid_shift_punch_in_time||null,
  mid_shift_punch_in_image:original.mid_shift_punch_in_image||null,
  latitude_mid_in:original.latitude_mid_in??null,longitude_mid_in:original.longitude_mid_in??null,
  mid_in_address:original.mid_in_address||null,
  attendance_source:original.supervisor_in_by||original.supervisor_out_by||original.supervisor_in_capture||original.supervisor_out_capture?'supervisor':'punch'
 };
}
module.exports={transferredAttendanceEvidence};
