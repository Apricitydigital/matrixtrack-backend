// Existing attendance calculation fixtures have no access blocks. The separate
// professionalAttendanceBlock integration suite exercises the real access rules.
module.exports = {
  ensureAttendanceBlockSchema: async () => {},
  lockAttendanceProfiles: async () => [],
  loadPunchInContext: async (client, id) => {
    const profile = (await client.query('SELECT id,selfie_url,is_active FROM professional_employees WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!profile?.is_active) return { profile };
    const cutoff = (await client.query(`SELECT t.cutoff_time,transaction_timestamp() AS attempted_at,
      s.enabled AND (transaction_timestamp() AT TIME ZONE 'Asia/Kolkata') >
        ((transaction_timestamp() AT TIME ZONE 'Asia/Kolkata')::date + t.cutoff_time + INTERVAL '15 minutes') AS is_late
      FROM professional_employees p LEFT JOIN professional_punch_cutoffs t ON t.professional_id=p.id
      CROSS JOIN professional_punch_settings s WHERE p.id=$1 AND s.id=1 FOR SHARE OF s`, [id])).rows[0] || {};
    return { profile, cutoff, block: { is_attendance_blocked: false } };
  },
  getAttendanceBlock: async () => ({ is_attendance_blocked: false }),
  withAttendanceBlocks: async rows => rows,
  sendBlocked() { throw new Error('Unexpected block in an unblocked fixture'); },
};
