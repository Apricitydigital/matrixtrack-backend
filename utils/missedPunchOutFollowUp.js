const pool = require('../config/db');
const { todayIST } = require('./selfAttendanceWeeklyOff');
const { ensureSelfAttendanceLeaveSchema } = require('./selfAttendanceLeaveSchema');
const { sendPushToSelfAttendances } = require('./selfAttendancePushService');

const FOLLOW_UP_LOCK_ID = 913422;
const DAY_MS = 24 * 60 * 60 * 1000;

const asDate = value => {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};
const dateKey = date => date.toISOString().slice(0, 10);
const shiftDate = (value, offset) => {
  const date = asDate(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + offset);
  return dateKey(date);
};

async function ensureMissedPunchOutSchema(db = pool) {
  await ensureSelfAttendanceLeaveSchema();
  await db.query(`CREATE TABLE IF NOT EXISTS self_attendance_punchout_acknowledgments (
    self_attendance_id UUID NOT NULL REFERENCES self_attendance_employees(id) ON DELETE CASCADE,
    streak_start_date DATE NOT NULL,
    streak_days INTEGER NOT NULL CHECK (streak_days >= 3),
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (self_attendance_id, streak_start_date)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_punchout_acknowledged_at
    ON self_attendance_punchout_acknowledgments (acknowledged_at DESC)`);
  await db.query(`CREATE TABLE IF NOT EXISTS employee_punchout_acknowledgments (
    emp_id INTEGER NOT NULL REFERENCES employee(emp_id) ON DELETE CASCADE,
    streak_start_date DATE NOT NULL,
    streak_days INTEGER NOT NULL CHECK (streak_days >= 3),
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (emp_id, streak_start_date)
  )`);
}

const MISSED_PUNCHES_CTE = `WITH missed AS (
  SELECT 'regular'::text AS employee_kind,e.emp_id::text AS employee_id,
    e.name AS full_name,e.emp_code,COALESCE(a.ward_id,e.ward_id) AS site_id,
    w.ward_name AS site_name,a.date::date AS date,a.punch_in_time AS punch_in,
    a.punch_out_time AS punch_out,
    (COALESCE(a.auto_punched_out,FALSE) OR LOWER(COALESCE(a.out_address,'')) LIKE '%auto punch%') AS auto_punched_out
  FROM attendance a JOIN employee e ON e.emp_id=a.emp_id
  JOIN wards w ON w.ward_id=COALESCE(a.ward_id,e.ward_id)
  WHERE a.date::date BETWEEN $2::date AND $3::date AND a.punch_in_time IS NOT NULL
    AND (a.punch_out_time IS NULL OR COALESCE(a.auto_punched_out,FALSE)
      OR LOWER(COALESCE(a.out_address,'')) LIKE '%auto punch%')
    AND NOT COALESCE(e.self_attendance_enabled,FALSE)
    AND NOT EXISTS(SELECT 1 FROM self_attendance_employees p WHERE p.emp_code=e.emp_code)
    AND EXISTS(SELECT 1 FROM self_attendance_site_access s
      WHERE s.self_attendance_id=$1 AND s.kothi_id=COALESCE(a.ward_id,e.ward_id))
    AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM wards fw WHERE fw.ward_id=COALESCE(a.ward_id,e.ward_id)
      AND COALESCE(fw.zone_id,(SELECT sec.zone_id FROM sectors sec WHERE sec.sector_id=fw.sector_id))=$4))
    AND ($5::int IS NULL OR COALESCE(a.ward_id,e.ward_id)=$5)
    AND ($6::text='' OR lower(COALESCE(e.name,'')||' '||COALESCE(e.emp_code,'')) LIKE '%'||lower($6)||'%')
  UNION ALL
  SELECT 'self_attendance'::text,p.id::text,p.full_name,p.emp_code,
    COALESCE(a.kothi_id,p.kothi_id),w.ward_name,a.date::date,a.punch_in,a.punch_out,
    (COALESCE(a.auto_punched_out,FALSE) OR LOWER(COALESCE(a.out_address,'')) LIKE '%auto punch%')
  FROM self_attendance_records a JOIN self_attendance_employees p ON p.id=a.self_attendance_id
  LEFT JOIN wards w ON w.ward_id=COALESCE(a.kothi_id,p.kothi_id)
  WHERE a.date BETWEEN $2::date AND $3::date AND a.punch_in IS NOT NULL
    AND (a.punch_out IS NULL OR COALESCE(a.auto_punched_out,FALSE)
      OR LOWER(COALESCE(a.out_address,'')) LIKE '%auto punch%')
    AND EXISTS(SELECT 1 FROM self_attendance_site_access s
      WHERE s.self_attendance_id=$1 AND s.kothi_id=COALESCE(a.kothi_id,p.kothi_id))
    AND ($4::int IS NULL OR COALESCE(p.zone_id,(SELECT sec.zone_id FROM sectors sec WHERE sec.sector_id=p.ward_id))=$4)
    AND ($5::int IS NULL OR COALESCE(a.kothi_id,p.kothi_id)=$5)
    AND ($6::text='' OR lower(COALESCE(p.full_name,'')||' '||COALESCE(p.emp_code,'')) LIKE '%'||lower($6)||'%')
)`;

async function getMissedPunchOutReport(db, actorId, startDate, endDate, filters = {}) {
  const { rows } = await db.query(`${MISSED_PUNCHES_CTE}
    SELECT employee_kind,employee_id,full_name,emp_code,site_id,site_name,
      COUNT(DISTINCT date)::int AS missed_days,
      COUNT(*) FILTER(WHERE auto_punched_out)::int AS auto_punched_days,
      COUNT(*) FILTER(WHERE NOT auto_punched_out)::int AS still_open_days,
      JSON_AGG(JSON_BUILD_OBJECT('date',date::text,'punch_in',punch_in,
        'punch_out',punch_out,'status',CASE WHEN auto_punched_out THEN 'auto_punched_out' ELSE 'punch_out_pending' END)
        ORDER BY date DESC) AS dates
    FROM missed GROUP BY employee_kind,employee_id,full_name,emp_code,site_id,site_name
    ORDER BY missed_days DESC,full_name,employee_kind,employee_id`, [actorId,startDate,endDate,filters.zoneId||null,filters.siteId||null,filters.search||'']);
  const data = rows.map(row => ({ ...row, dates: Array.isArray(row.dates) ? row.dates : [] }));
  return {
    start_date: startDate,
    end_date: endDate,
    total: data.length,
    missed_days: data.reduce((sum,row) => sum + Number(row.missed_days || 0),0),
    auto_punched_days: data.reduce((sum,row) => sum + Number(row.auto_punched_days || 0),0),
    still_open_days: data.reduce((sum,row) => sum + Number(row.still_open_days || 0),0),
    data,
  };
}

async function getEmployeePunchOutStreak(db, employeeId) {
  const yesterday = shiftDate(todayIST(), -1);
  const startDate = shiftDate(yesterday, -89);
  const { rows } = await db.query(`SELECT DISTINCT date::text AS date
    FROM self_attendance_records
    WHERE self_attendance_id=$1 AND date BETWEEN $2::date AND $3::date
      AND punch_in IS NOT NULL AND (punch_out IS NULL OR COALESCE(auto_punched_out,FALSE)
        OR LOWER(COALESCE(out_address,'')) LIKE '%auto punch%')
    ORDER BY date DESC`, [employeeId,startDate,yesterday]);
  const missedDates = new Set(rows.map(row => String(row.date).slice(0,10)));
  let cursor = yesterday;
  let count = 0;
  while (missedDates.has(cursor)) { count += 1; cursor = shiftDate(cursor, -1); }
  return { streak_days: count, streak_start_date: count ? shiftDate(yesterday, -(count - 1)) : null, dates: [...missedDates].sort().reverse().slice(0,count) };
}

async function getRegularEmployeePunchOutStreak(db, employeeId) {
  const yesterday=shiftDate(todayIST(),-1);
  const startDate=shiftDate(yesterday,-89);
  const {rows}=await db.query(`SELECT DISTINCT date::text AS date FROM attendance
    WHERE emp_id=$1 AND date::date BETWEEN $2::date AND $3::date AND punch_in_time IS NOT NULL
      AND (punch_out_time IS NULL OR COALESCE(auto_punched_out,FALSE)
        OR LOWER(COALESCE(out_address,'')) LIKE '%auto punch%')
    ORDER BY date DESC`,[employeeId,startDate,yesterday]);
  const missedDates=new Set(rows.map(row=>String(row.date).slice(0,10)));
  let cursor=yesterday,count=0;
  while(missedDates.has(cursor)){count+=1;cursor=shiftDate(cursor,-1);}
  return {streak_days:count,streak_start_date:count?shiftDate(yesterday,-(count-1)):null,dates:[...missedDates].sort().reverse().slice(0,count)};
}

async function getPendingPunchOutWarning(db, employeeId) {
  await ensureMissedPunchOutSchema(db);
  const streak = await getEmployeePunchOutStreak(db, employeeId);
  if (streak.streak_days < 3) return { required: false, ...streak };
  const { rows } = await db.query(`SELECT acknowledged_at FROM self_attendance_punchout_acknowledgments
    WHERE self_attendance_id=$1 AND streak_start_date=$2::date`, [employeeId,streak.streak_start_date]);
  if (rows.length) return { required: false, acknowledged: true, ...streak };
  return { required: true, acknowledged: false, ...streak };
}

async function acknowledgePunchOutWarning(db, employeeId, streakStartDate) {
  await ensureMissedPunchOutSchema(db);
  const streak = await getEmployeePunchOutStreak(db, employeeId);
  if (streak.streak_days < 3 || streak.streak_start_date !== streakStartDate) {
    throw Object.assign(new Error('This warning is no longer current. Refresh your attendance.'), { status: 409 });
  }
  await db.query(`INSERT INTO self_attendance_punchout_acknowledgments
    (self_attendance_id,streak_start_date,streak_days)
    VALUES($1,$2::date,$3) ON CONFLICT(self_attendance_id,streak_start_date) DO NOTHING`,
  [employeeId,streak.streak_start_date,streak.streak_days]);
  return { acknowledged: true, streak_days: streak.streak_days };
}

async function getPendingRegularPunchOutWarning(db, employeeId) {
  await ensureMissedPunchOutSchema(db);
  const streak=await getRegularEmployeePunchOutStreak(db,employeeId);
  if(streak.streak_days<3)return {required:false,...streak};
  const {rows}=await db.query(`SELECT acknowledged_at FROM employee_punchout_acknowledgments
    WHERE emp_id=$1 AND streak_start_date=$2::date`,[employeeId,streak.streak_start_date]);
  return rows.length?{required:false,acknowledged:true,...streak}:{required:true,acknowledged:false,...streak};
}

async function acknowledgeRegularPunchOutWarning(db, employeeId, streakStartDate) {
  await ensureMissedPunchOutSchema(db);
  const streak=await getRegularEmployeePunchOutStreak(db,employeeId);
  if(streak.streak_days<3||streak.streak_start_date!==streakStartDate){
    throw Object.assign(new Error('This warning is no longer current. Refresh your attendance.'),{status:409});
  }
  await db.query(`INSERT INTO employee_punchout_acknowledgments(emp_id,streak_start_date,streak_days)
    VALUES($1,$2::date,$3) ON CONFLICT(emp_id,streak_start_date) DO NOTHING`,[employeeId,streak.streak_start_date,streak.streak_days]);
  return {acknowledged:true,streak_days:streak.streak_days};
}

async function runMissedPunchOutFollowUp(options = {}) {
  await ensureMissedPunchOutSchema();
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1) AS locked',[FOLLOW_UP_LOCK_ID])).rows[0]?.locked === true;
    if (!locked) return { skipped: true, employeeWarnings: 0, projectHeadNotices: 0 };
    const yesterday = shiftDate(todayIST(), -1);
    const dayBefore = shiftDate(yesterday, -1);
    const twoDaysBefore = shiftDate(yesterday, -2);
    const { rows: candidates } = await client.query(`SELECT DISTINCT p.id AS self_attendance_id
      FROM self_attendance_employees p
      WHERE p.is_active=TRUE
        AND EXISTS(SELECT 1 FROM self_attendance_records d WHERE d.self_attendance_id=p.id
          AND d.date=$1::date AND d.punch_in IS NOT NULL AND (d.punch_out IS NULL
            OR COALESCE(d.auto_punched_out,FALSE) OR LOWER(COALESCE(d.out_address,'')) LIKE '%auto punch%'))
        AND EXISTS(SELECT 1 FROM self_attendance_records d WHERE d.self_attendance_id=p.id
          AND d.date=$2::date AND d.punch_in IS NOT NULL AND (d.punch_out IS NULL
            OR COALESCE(d.auto_punched_out,FALSE) OR LOWER(COALESCE(d.out_address,'')) LIKE '%auto punch%'))
        AND EXISTS(SELECT 1 FROM self_attendance_records d WHERE d.self_attendance_id=p.id
          AND d.date=$3::date AND d.punch_in IS NOT NULL AND (d.punch_out IS NULL
            OR COALESCE(d.auto_punched_out,FALSE) OR LOWER(COALESCE(d.out_address,'')) LIKE '%auto punch%'))`,
    [yesterday,dayBefore,twoDaysBefore]);

    // Candidate query finds at least three consecutive missed days. Calculate
    // the true run start before checking acknowledgment and notification guards.
    const employeeWarnings = [];
    for (const candidate of candidates) {
      const streak = await getEmployeePunchOutStreak(client,candidate.self_attendance_id);
      if (streak.streak_days < 3) continue;
      const alreadyAcknowledged = (await client.query(`SELECT 1 FROM self_attendance_punchout_acknowledgments
        WHERE self_attendance_id=$1 AND streak_start_date=$2::date`,
      [candidate.self_attendance_id,streak.streak_start_date])).rows.length > 0;
      if (alreadyAcknowledged) continue;
      const alreadyNotified = (await client.query(`SELECT 1 FROM self_attendance_notifications
        WHERE self_attendance_id=$1 AND type='missed-punch-out-warning'
          AND metadata->>'streak_start_date'=$2::text LIMIT 1`,
      [candidate.self_attendance_id,streak.streak_start_date])).rows.length > 0;
      if (alreadyNotified) continue;
      const inserted = await client.query(`INSERT INTO self_attendance_notifications
        (self_attendance_id,type,title,message,metadata)
        VALUES($1,'missed-punch-out-warning','Action needed: punch-out reminders',
          'You have missed manual punch-out for '||$2::text||' consecutive days. Continued missed punch-outs will reduce your salary under the attendance policy. Please punch out every working day and acknowledge this notice.',
          jsonb_build_object('category','attendance','kind','missed-punch-out-warning',
            'streak_start_date',$3::text,'streak_days',$2::int))
        RETURNING id,self_attendance_id,type,title,message,metadata`,
      [candidate.self_attendance_id,streak.streak_days,streak.streak_start_date]);
      employeeWarnings.push(inserted.rows[0]);
    }

    const pmResult = await client.query(`WITH missed AS (
      SELECT COALESCE(a.ward_id,e.ward_id) AS site_id,'regular:'||e.emp_id::text AS person_id
      FROM attendance a JOIN employee e ON e.emp_id=a.emp_id
      WHERE a.date::date=$1::date AND a.punch_in_time IS NOT NULL
        AND (a.punch_out_time IS NULL OR COALESCE(a.auto_punched_out,FALSE)
          OR LOWER(COALESCE(a.out_address,'')) LIKE '%auto punch%')
        AND NOT COALESCE(e.self_attendance_enabled,FALSE)
        AND NOT EXISTS(SELECT 1 FROM self_attendance_employees p WHERE p.emp_code=e.emp_code)
      UNION ALL
      SELECT COALESCE(a.kothi_id,p.kothi_id),'self:'||p.id::text
      FROM self_attendance_records a JOIN self_attendance_employees p ON p.id=a.self_attendance_id
      WHERE a.date=$1::date AND a.punch_in IS NOT NULL
        AND (a.punch_out IS NULL OR COALESCE(a.auto_punched_out,FALSE)
          OR LOWER(COALESCE(a.out_address,'')) LIKE '%auto punch%')
    ), counts AS (
      SELECT s.self_attendance_id,COUNT(DISTINCT m.person_id)::int AS people_count
      FROM missed m JOIN self_attendance_site_access s ON s.kothi_id=m.site_id
      JOIN self_attendance_designation_assignments da ON da.self_attendance_id=s.self_attendance_id
      JOIN designation d ON d.designation_id=da.designation_id
      JOIN self_attendance_employees reviewer ON reviewer.id=s.self_attendance_id AND reviewer.is_active=TRUE
      WHERE d.designation_name IN ('Project Manager','Project Head / Site Head','HO Coordinator','Head of Department')
      GROUP BY s.self_attendance_id
    )
    INSERT INTO self_attendance_notifications(self_attendance_id,type,title,message,metadata)
    SELECT c.self_attendance_id,'missed-punch-out-daily','Team punch-out follow-up',
      'Yesterday, '||c.people_count||' people in your assigned team missed manual punch-out. Auto-punched records are included. Tap to review the date-wise list.',
      jsonb_build_object('category','attendance','kind','missed-punch-out-report','reminder_date',$1::text,'people_count',c.people_count)
    FROM counts c WHERE NOT EXISTS(SELECT 1 FROM self_attendance_notifications n
      WHERE n.self_attendance_id=c.self_attendance_id AND n.type='missed-punch-out-daily'
        AND n.metadata->>'reminder_date'=$1::text)
    RETURNING id,self_attendance_id,type,title,message,metadata`, [yesterday]);

    const notices = [...employeeWarnings,...pmResult.rows];
    let pushed = { sent: 0, failed: 0, noDestination: 0 };
    if (notices.length) {
      try { pushed = await sendPushToSelfAttendances(notices); }
      catch (error) { console.warn('[MissedPunchOutFollowUp] Push send failed:',error.message); }
    }
    if (options.verbose || notices.length) console.log(`[MissedPunchOutFollowUp] employee warnings: ${employeeWarnings.length}, Project Head notices: ${pmResult.rowCount || 0}, push sent: ${pushed.sent || 0}`);
    return { employeeWarnings: employeeWarnings.length, projectHeadNotices: pmResult.rowCount || 0, pushSent: pushed.sent || 0 };
  } finally {
    if (locked) try { await client.query('SELECT pg_advisory_unlock($1)',[FOLLOW_UP_LOCK_ID]); } catch (_) {}
    client.release();
  }
}

module.exports = {
  ensureMissedPunchOutSchema,
  getMissedPunchOutReport,
  getEmployeePunchOutStreak,
  getRegularEmployeePunchOutStreak,
  getPendingPunchOutWarning,
  acknowledgePunchOutWarning,
  getPendingRegularPunchOutWarning,
  acknowledgeRegularPunchOutWarning,
  runMissedPunchOutFollowUp,
  shiftDate,
};
