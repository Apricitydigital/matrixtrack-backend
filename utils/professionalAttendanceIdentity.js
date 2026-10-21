const identities = process.env.PROFESSIONAL_ATTENDANCE_IDENTITY_LINKS_ENABLED === 'false'
  ? [] : require('../config/professionalAttendanceIdentities');

const groupsById = new Map();
for (const group of identities) {
  for (const id of group.profileIds) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || groupsById.has(id)) throw new Error('Invalid attendance identity configuration');
    groupsById.set(id, group);
  }
  if (!group.profileIds.includes(group.primaryId)) throw new Error('Missing primary attendance profile');
}

function findIdentity(id) {
  return typeof id === 'string' ? groupsById.get(id.toLowerCase()) : undefined;
}

function primaryAttendanceId(id) {
  return findIdentity(id)?.primaryId || id;
}

function attendanceSourceIds(id) {
  return findIdentity(id)?.profileIds || [id];
}

function reviewedHistorySql(id) {
  if (!findIdentity(id)) return null;
  return `WITH ${linksSql} SELECT source_id FROM attendance_identity_links WHERE primary_id='${primaryAttendanceId(id)}'::uuid`;
}

// A reviewed link stops being eligible if a profile is moved to another scope,
// the primary is disabled, or overlapping attendance/leave dates are introduced.
// Such records remain separate in reports and cannot be used for alias punches.
const values = identities.flatMap(group => group.profileIds.map(id => `('${id}'::uuid,'${group.primaryId}'::uuid)`)).join(',') || '(NULL::uuid,NULL::uuid)';
const linksSql = `
  attendance_identity_config(source_id,primary_id) AS (VALUES ${values}),
  attendance_identity_links AS (
    SELECT cfg.* FROM attendance_identity_config cfg
    JOIN professional_employees source ON source.id=cfg.source_id
    JOIN professional_employees primary_profile ON primary_profile.id=cfg.primary_id
    WHERE primary_profile.is_active=true
      AND NOT EXISTS (
        SELECT 1 FROM attendance_identity_config member
        LEFT JOIN professional_employees p ON p.id=member.source_id
        WHERE member.primary_id=cfg.primary_id AND (p.id IS NULL
          OR ROW(p.city_id,p.zone_id,p.ward_id,p.kothi_id) IS DISTINCT FROM
             ROW(primary_profile.city_id,primary_profile.zone_id,primary_profile.ward_id,primary_profile.kothi_id))
      )
      AND NOT EXISTS (
        SELECT a.date FROM professional_attendance a
        JOIN attendance_identity_config member ON member.source_id=a.professional_id
        WHERE member.primary_id=cfg.primary_id GROUP BY a.date HAVING COUNT(*)>1
      )
      AND NOT EXISTS (
        SELECT l.requested_date FROM professional_leave_requests l
        JOIN attendance_identity_config member ON member.source_id=l.professional_id
        WHERE member.primary_id=cfg.primary_id GROUP BY l.requested_date HAVING COUNT(*)>1
      )
  )`;

const sources = {
  professional_employees: 'attendance_identity_employees',
  professional_attendance: 'attendance_identity_attendance',
  professional_leave_requests: 'attendance_identity_leaves',
};

// Keep the owner column explicit so PostgreSQL can push professional/date
// filters into both UNION branches and use the existing attendance indexes.
// Converting complete rows through JSON here prevents that optimization.
const attendanceColumns = ['id','professional_id','date','punch_in','punch_out','attempted_punch_in',
  'punch_approval_status','auto_punched_out','out_address','punch_in_latitude','punch_in_longitude',
  'punch_out_latitude','punch_out_longitude','punch_in_photo_url','punch_out_photo_url',
  'ward_id','city_id','zone_id'];
const leaveColumns = ['id','professional_id','requested_date','leave_type','status','requested_at',
  'reviewed_at','review_note','reviewed_by','pm_reviewer_id','ho_reviewer_id','hod_reviewer_id'];
const projectColumns = (columns, alias, linked=false) => columns.map(column => linked && column==='professional_id'
  ? 'm.primary_id AS professional_id' : `${alias}.${column}`).join(',');

// Only SELECT queries from the reporting controller use this projection. The
// stored rows, approval foreign keys, photos and original source IDs never move.
// UNION ALL leaves every unlinked row on the original, indexable relation.
function withAttendanceIdentity(sql, params = []) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Attendance identity projection is read-only');
  if (!identities.length) return sql;
  let projected = sql.replace(/\b(professional_employees|professional_attendance|professional_leave_requests)\b/g, name => sources[name]);
  // Old employee-specific links resolve only while the live link is eligible.
  // Do not rewrite the actual parameter or lose its original visibility scope.
  projected = projected.replace(/\$(\d+)\b/g, (placeholder, index) => findIdentity(params[Number(index)-1])
    ? `(SELECT COALESCE((SELECT primary_id FROM attendance_identity_links WHERE source_id=${placeholder}::uuid),${placeholder}::uuid))`
    : placeholder);
  const ctes = `${linksSql},
    attendance_identity_original_profiles AS NOT MATERIALIZED (
      SELECT p.* FROM professional_employees p JOIN attendance_identity_links m ON m.source_id=p.id
    ),
    attendance_identity_employees AS NOT MATERIALIZED (
      SELECT p.* FROM professional_employees p
      WHERE NOT EXISTS (SELECT 1 FROM attendance_identity_links m WHERE m.source_id=p.id AND m.source_id<>m.primary_id)
    ),
    attendance_identity_attendance AS NOT MATERIALIZED (
      SELECT ${projectColumns(attendanceColumns,'a')} FROM professional_attendance a
      WHERE NOT EXISTS (SELECT 1 FROM attendance_identity_links m WHERE m.source_id=a.professional_id AND m.source_id<>m.primary_id)
      UNION ALL
      SELECT ${projectColumns(attendanceColumns,'a',true)}
      FROM professional_attendance a JOIN attendance_identity_links m ON m.source_id=a.professional_id AND m.source_id<>m.primary_id
    ),
    attendance_identity_leaves AS NOT MATERIALIZED (
      SELECT ${projectColumns(leaveColumns,'l')} FROM professional_leave_requests l
      WHERE NOT EXISTS (SELECT 1 FROM attendance_identity_links m WHERE m.source_id=l.professional_id AND m.source_id<>m.primary_id)
      UNION ALL
      SELECT ${projectColumns(leaveColumns,'l',true)}
      FROM professional_leave_requests l JOIN attendance_identity_links m ON m.source_id=l.professional_id AND m.source_id<>m.primary_id
    )`;
  return /^\s*WITH\b/i.test(projected)
    ? projected.replace(/^\s*WITH\s+/i, `WITH ${ctes}, `)
    : `WITH ${ctes} ${projected}`;
}

function reviewedPaidDaySql(person, date) {
  if (!identities.length) return `professional_is_paid_day(${person},${date})`;
  return `(professional_is_paid_day(${person},${date}) OR (
    EXISTS(SELECT 1 FROM attendance_identity_links m WHERE m.primary_id=${person}) AND (
      EXISTS(SELECT 1 FROM professional_attendance identity_a WHERE identity_a.professional_id=${person} AND identity_a.date=${date} AND identity_a.punch_in IS NOT NULL)
      OR EXISTS(SELECT 1 FROM professional_leave_requests identity_l WHERE identity_l.professional_id=${person} AND identity_l.requested_date=${date} AND identity_l.status='approved')
    )))`;
}

function reviewedSearchSql(person, pattern) {
  if (!identities.length) return 'FALSE';
  // The originals remain searchable by their old code/mobile after consolidation.
  return `EXISTS(SELECT 1 FROM attendance_identity_links identity_m
    JOIN attendance_identity_original_profiles identity_p ON identity_p.id=identity_m.source_id
    WHERE identity_m.primary_id=${person} AND (identity_p.full_name ILIKE ${pattern}
      OR identity_p.emp_code ILIKE ${pattern} OR identity_p.mobile ILIKE ${pattern} OR identity_p.email ILIKE ${pattern}))`;
}

async function resolveAttendanceIdentity(req, res, next) {
  const id = req.professional?.professional_id;
  const group = findIdentity(id);
  if (!group) return next();
  try {
    const pool = require('../config/db');
    const { rows } = await pool.query(`WITH ${linksSql}
      SELECT p.city_id,p.zone_id,p.ward_id,p.kothi_id,p.face_locked,
        (SELECT a.professional_id FROM professional_attendance a
          JOIN attendance_identity_links current_link ON current_link.source_id=a.professional_id
          WHERE current_link.primary_id=m.primary_id
            AND a.date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date LIMIT 1) AS current_attendance_profile_id
      FROM attendance_identity_links m JOIN professional_employees p ON p.id=m.primary_id
      WHERE m.source_id=$1`, [id]);
    if (!rows.length) return res.status(409).json({success:false,message:'Attendance profiles require review. Please contact your administrator.'});
    const { current_attendance_profile_id, ...profile } = rows[0];
    const continueExisting = ['/attendance/punch-out','/attendance/status'].includes(req.route?.path);
    req.professional = {...req.professional,...profile,
      professional_id:continueExisting && current_attendance_profile_id ? current_attendance_profile_id : group.primaryId};
    return next();
  } catch (error) {
    return res.status(503).json({success:false,message:'Unable to verify attendance profile. Please retry.'});
  }
}

module.exports = { primaryAttendanceId, attendanceSourceIds, reviewedHistorySql, withAttendanceIdentity, reviewedPaidDaySql, reviewedSearchSql, resolveAttendanceIdentity, linksSql };
