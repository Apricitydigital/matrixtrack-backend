const identities = require('../config/selfAttendanceRecordsIdentities');
const { attendanceSourceIds } = require('./selfAttendanceRecordsIdentity');

// Match the same reviewed aliases as punch authorization and block/unblock.
// Expressions passed here are internal SQL identifiers, never request input.
function attendanceBlockSql(employeeId, reportDate = null) {
  const groups = identities.filter(group => attendanceSourceIds(group.primaryId).length > 1);
  const ids = groups.length ? `CASE ${groups.map(group => {
    const values = group.profileIds.map(id => `'${id}'::uuid`).join(',');
    return `WHEN ${employeeId}=ANY(ARRAY[${values}]) THEN ARRAY[${values}]`;
  }).join(' ')} ELSE ARRAY[${employeeId}] END` : `ARRAY[${employeeId}]`;
  return `EXISTS(SELECT 1 FROM self_attendance_records_blocks access_block
    WHERE access_block.is_blocked=TRUE AND access_block.self_attendance_id=ANY(${ids})
    ${reportDate ? `AND (access_block.updated_at AT TIME ZONE 'Asia/Kolkata') < date_trunc('month', (${reportDate})::date::timestamp)` : ''})`;
}

// Keep the blocking month and all earlier reports. Unblocking immediately
// restores report inclusion without modifying stored attendance or payable days.
function attendanceReportVisibleSql(employeeId, reportDate) {
  return `NOT (${attendanceBlockSql(employeeId, reportDate)})`;
}

module.exports = { attendanceBlockSql, attendanceReportVisibleSql };
