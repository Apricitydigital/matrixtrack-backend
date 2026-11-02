const pool = require('../config/db');

// The admin-assigned punch cutoff drives the cron; personal reminder_time is legacy.
const readSettings = async id => (await pool.query(`
  SELECT p.reminder_enabled IS DISTINCT FROM FALSE AS reminder_enabled,
    to_char(COALESCE(t.cutoff_time,'10:00'::time),'HH24:MI') AS reminder_time,
    'assigned-punch-in'::text AS schedule_source
  FROM self_attendance_employees p
  LEFT JOIN self_attendance_punch_cutoffs t ON t.self_attendance_id=p.id
  WHERE p.id=$1`, [id])).rows[0];

const getReminderSettings = async (req,res) => {
  try {
    const data=await readSettings(req.self_attendance.self_attendance_id);
    if (!data) return res.status(404).json({success:false,message:'Self Attendance employee not found'});
    return res.json({success:true,data});
  } catch (_) {return res.status(500).json({success:false,message:'Unable to load reminder settings.'});}
};
const saveReminderSettings = async (req,res) => {
  if (typeof req.body?.reminder_enabled !== 'boolean') return res.status(400).json({success:false,message:'Choose whether reminders are enabled.'});
  try {
    const result=await pool.query('UPDATE self_attendance_employees SET reminder_enabled=$1 WHERE id=$2 RETURNING id',
      [req.body.reminder_enabled,req.self_attendance.self_attendance_id]);
    if (!result.rows.length) return res.status(404).json({success:false,message:'Self Attendance employee not found'});
    return res.json({success:true,message:'Reminder preference saved. Reminders follow the assigned punch-in time (IST).',data:await readSettings(req.self_attendance.self_attendance_id)});
  } catch (_) {return res.status(500).json({success:false,message:'Unable to save reminder settings.'});}
};
module.exports={getReminderSettings,saveReminderSettings};
