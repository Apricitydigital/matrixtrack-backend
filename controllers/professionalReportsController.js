const { runQueryWithTimeout: runRawQuery } = require('../utils/queryRunner');
const { withAttendanceIdentity, reviewedPaidDaySql, reviewedSearchSql } = require('../utils/professionalAttendanceIdentity');
const runQueryWithTimeout = (sql, params = []) => runRawQuery(withAttendanceIdentity(sql, params), params);
const { buildVisibilityScope } = require('../utils/professionalAccess');
const { getSignedS3Url } = require('../utils/s3SelfPunch');
const logger = require('../utils/logger');
const pool = require('../config/db');
const { ensurePunchCutoffSchema } = require('../utils/professionalPunchCutoff');
const { ensureProfessionalLeaveSchema } = require('../utils/professionalLeaveSchema');

let attendanceReportColumnsEnsured = false;
const ensureAttendanceReportColumns = async () => {
  await ensurePunchCutoffSchema();
  if (attendanceReportColumnsEnsured) return;
  await pool.query(`
    ALTER TABLE professional_attendance
      ADD COLUMN IF NOT EXISTS punch_in_latitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_in_longitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_out_latitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_out_longitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_in_photo_url VARCHAR(1024),
      ADD COLUMN IF NOT EXISTS punch_out_photo_url VARCHAR(1024),
      ADD COLUMN IF NOT EXISTS auto_punched_out BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS out_address TEXT
  `);
  attendanceReportColumnsEnsured = true;
};

const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

const getTodayInIST = () => (
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
);

const getValidatedDateRange = (startDate, endDate) => {
  if (!startDate || !endDate) return null;
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return null;
  if (startDate > endDate) return null;
  return { startDate, endDate };
};

const buildWardAndKothiFilters = (ward_id, kothi_id, startParamCount, params) => {
  let sql = '';
  let paramCount = startParamCount;

  if (ward_id) {
    paramCount++;
    sql += `
      AND (
        pe.ward_id::text = $${paramCount}::text
        OR pe.kothi_id::text = $${paramCount}::text
        OR EXISTS (
          SELECT 1 FROM wards w_filter
          WHERE w_filter.ward_id::text = pe.ward_id::text
            AND (w_filter.sector_id::text = $${paramCount}::text OR w_filter.ward_id::text = $${paramCount}::text)
        )
        OR EXISTS (
          SELECT 1 FROM wards w_filter
          WHERE w_filter.ward_id::text = pe.kothi_id::text
            AND (w_filter.sector_id::text = $${paramCount}::text OR w_filter.ward_id::text = $${paramCount}::text)
        )
        OR EXISTS (
          SELECT 1 FROM wards w_filter
          WHERE w_filter.sector_id::text = pe.ward_id::text
            AND w_filter.ward_id::text = $${paramCount}::text
        )
        OR EXISTS (
          SELECT 1 FROM self_punch_requests spr_filter
          WHERE spr_filter.id = pe.request_id
            AND (
              spr_filter.ward_id::text = $${paramCount}::text
              OR spr_filter.kothi_id::text = $${paramCount}::text
              OR EXISTS (
                SELECT 1 FROM wards w_filter
                WHERE (w_filter.ward_id::text = spr_filter.ward_id::text OR w_filter.ward_id::text = spr_filter.kothi_id::text)
                  AND (w_filter.sector_id::text = $${paramCount}::text OR w_filter.ward_id::text = $${paramCount}::text)
              )
            )
        )
      )
    `;
    params.push(ward_id);
  }

  if (kothi_id) {
    paramCount++;
    sql += `
      AND (
        pe.kothi_id::text = $${paramCount}::text
        OR pe.ward_id::text = $${paramCount}::text
        OR EXISTS (
          SELECT 1 FROM wards w_filter
          WHERE (w_filter.ward_id::text = pe.kothi_id::text OR w_filter.ward_id::text = pe.ward_id::text)
            AND w_filter.ward_id::text = $${paramCount}::text
        )
        OR EXISTS (
          SELECT 1 FROM wards w_filter
          WHERE (w_filter.sector_id::text = pe.ward_id::text OR w_filter.sector_id::text = pe.kothi_id::text)
            AND w_filter.ward_id::text = $${paramCount}::text
        )
        OR EXISTS (
          SELECT 1 FROM self_punch_requests spr_filter
          WHERE spr_filter.id = pe.request_id
            AND (
              spr_filter.kothi_id::text = $${paramCount}::text
              OR spr_filter.ward_id::text = $${paramCount}::text
              OR EXISTS (
                SELECT 1 FROM wards w_filter
                WHERE (w_filter.ward_id::text = spr_filter.ward_id::text OR w_filter.ward_id::text = spr_filter.kothi_id::text)
                  AND w_filter.ward_id::text = $${paramCount}::text
              )
            )
        )
      )
    `;
    params.push(kothi_id);
  }

  return { sql, paramCount };
};

/**
 * @desc    Get paginated list of professional attendance
 * @route   GET /api/admin/professional-attendance
 */
const getAttendanceList = async (req, res) => {
  try {
    await ensureAttendanceReportColumns();
    await ensureProfessionalLeaveSchema();
    const { city_id, zone_id, ward_id, kothi_id, professional_id, date, month, page = 1, limit = 50, search } = req.query;
    const numericLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 10000);
    const numericPage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (numericPage - 1) * numericLimit;

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    
    let peFilters = `AND ${whereClause} AND pe.is_active = true`;
    let paramCount = params.length;
    let paFilters = '';
    let leaveDateParamIndex = null;

    if (search && String(search).trim()) {
      paramCount++;
      const searchPattern = `%${String(search).trim()}%`;
      peFilters += `
        AND (
          pe.full_name ILIKE $${paramCount}
          OR pe.emp_code ILIKE $${paramCount}
          OR pe.mobile ILIKE $${paramCount}
          OR pe.email ILIKE $${paramCount}
          OR ${reviewedSearchSql('pe.id',`$${paramCount}`)}
          OR z.zone_name ILIKE $${paramCount}
          OR c.city_name ILIKE $${paramCount}
          OR EXISTS (
            SELECT 1 FROM wards w_s WHERE w_s.ward_id = pe.ward_id AND w_s.ward_name ILIKE $${paramCount}
          )
          OR EXISTS (
            SELECT 1 FROM sectors s_s WHERE s_s.sector_id = pe.ward_id AND s_s.sector_name ILIKE $${paramCount}
          )
          OR EXISTS (
            SELECT 1 FROM wards k_s WHERE k_s.ward_id = pe.kothi_id AND k_s.ward_name ILIKE $${paramCount}
          )
        )
      `;
      params.push(searchPattern);
    }
    if (city_id) {
      paramCount++;
      peFilters += ` AND pe.city_id = $${paramCount}`;
      params.push(city_id);
    }
    if (zone_id) {
      paramCount++;
      peFilters += ` AND pe.zone_id = $${paramCount}`;
      params.push(zone_id);
    }

    const geoFilters = buildWardAndKothiFilters(ward_id, kothi_id, paramCount, params);
    peFilters += geoFilters.sql;
    paramCount = geoFilters.paramCount;

    if (professional_id) {
      paramCount++;
      peFilters += ` AND pe.id = $${paramCount}`;
      params.push(professional_id);
    }

    let paCheckJoin = '';
    let paCheckOrder = '';

    if (date) {
      paramCount++;
      paFilters += ` AND pa.date = $${paramCount}`;
      params.push(date);
      leaveDateParamIndex = paramCount;
      paCheckJoin = `
        LEFT JOIN professional_attendance pa_check
          ON pa_check.professional_id = pe.id
         AND pa_check.date = $${paramCount}::date
      `;
      paCheckOrder = `CASE WHEN pa_check.punch_in IS NOT NULL THEN 0 ELSE 1 END,`;
    } else if (month) {
      // YYYY-MM format
      const [yyyy, mm] = month.split('-');
      paramCount++;
      paFilters += ` AND EXTRACT(YEAR FROM pa.date) = $${paramCount}`;
      params.push(yyyy);
      paramCount++;
      paFilters += ` AND EXTRACT(MONTH FROM pa.date) = $${paramCount}`;
      params.push(mm);
      paCheckJoin = `
        LEFT JOIN professional_attendance pa_check
          ON pa_check.professional_id = pe.id
         AND EXTRACT(YEAR FROM pa_check.date) = $${paramCount - 1}
         AND EXTRACT(MONTH FROM pa_check.date) = $${paramCount}
      `;
      paCheckOrder = `CASE WHEN pa_check.punch_in IS NOT NULL THEN 0 ELSE 1 END,`;
    }

    const distinctCte = `
      ${cte ? cte + ',' : 'WITH'} distinct_pe AS (
        SELECT DISTINCT ON (
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text)
        ) pe.*
        FROM professional_employees pe
        JOIN zones z ON pe.zone_id = z.zone_id
        JOIN cities c ON pe.city_id = c.city_id
        ${paCheckJoin}
        WHERE 1=1 ${peFilters}
        ORDER BY
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text),
          ${paCheckOrder}
          pe.created_at DESC
      )
    `;

    const leaveDateExpr = leaveDateParamIndex ? `$${leaveDateParamIndex}::date` : "NULL::date";
    const query = `
      ${distinctCte}
      SELECT
        pa.id as attendance_id,
        pe.id as professional_id,
        pe.full_name,
        pe.emp_code,
        pe.mobile,
        pe.email,
        COALESCE(pa.date, leave_row.requested_date, ${leaveDateExpr}) as date,
        professional_is_week_off(pe.id,COALESCE(pa.date,leave_row.requested_date,${leaveDateExpr},(NOW() AT TIME ZONE 'Asia/Kolkata')::date)) AS is_weekly_off,
        EXISTS(SELECT 1 FROM professional_holidays h WHERE h.holiday_date=COALESCE(pa.date,leave_row.requested_date,${leaveDateExpr},(NOW() AT TIME ZONE 'Asia/Kolkata')::date)
          AND h.city_id=pe.city_id AND (h.zone_id IS NULL OR h.zone_id=pe.zone_id) AND (h.ward_id IS NULL OR h.ward_id=pe.ward_id) AND (h.kothi_id IS NULL OR h.kothi_id=pe.kothi_id)) AS is_holiday,
        pa.punch_in, pa.attempted_punch_in, pa.punch_approval_status,
        pa.punch_out,
        pa.auto_punched_out,
        pa.auto_punched_out AS is_auto_punch_out,
        pa.out_address,
        CASE
          WHEN pa.punch_in IS NULL OR pa.punch_out IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (pa.punch_out - pa.punch_in)) / 3600
        END AS hours_worked,
        pa.punch_in_latitude,
        pa.punch_in_longitude,
        pa.punch_out_latitude,
        pa.punch_out_longitude,
        pa.punch_in_photo_url,
        pa.punch_out_photo_url,
        leave_row.leave_type,
        leave_row.status AS leave_status,
        leave_row.review_note AS leave_review_note,
        leave_row.reviewed_at AS leave_reviewed_at,
        COALESCE((SELECT full_name FROM professional_employees WHERE id=leave_row.hod_reviewer_id),
          (SELECT full_name FROM professional_employees WHERE id=leave_row.ho_reviewer_id),
          (SELECT full_name FROM professional_employees WHERE id=leave_row.pm_reviewer_id),leave_reviewer.name) AS leave_reviewed_by_name,
        pe.selfie_url as profile_selfie_url,
        COALESCE(
          sec_pe.sector_name,
          sec_w_pe.sector_name,
          sec_wk.sector_name,
          sec_req.sector_name,
          sec_w_req.sector_name,
          sec.sector_name,
          sec_w.sector_name,
          w_pe.ward_name,
          w_req.ward_name,
          w.ward_name
        ) AS ward_name,
        COALESCE(
          wk.ward_name,
          wk_req.ward_name,
          w_pe.ward_name,
          w_req.ward_name,
          w.ward_name,
          sec_pe.sector_name
        ) AS kothi_name,
        z.zone_name,
        c.city_name
      FROM distinct_pe pe
      LEFT JOIN LATERAL (
        SELECT pa_inner.*
        FROM professional_attendance pa_inner
        WHERE pa_inner.professional_id = pe.id
          ${paFilters.replace(/pa\./g, 'pa_inner.')}
        ORDER BY pa_inner.date DESC, pa_inner.punch_in DESC
        LIMIT 1
      ) pa ON TRUE
      LEFT JOIN LATERAL (
        SELECT plr.*
        FROM professional_leave_requests plr
        WHERE plr.professional_id = pe.id
          AND (
            (pa.date IS NOT NULL AND plr.requested_date = pa.date)
            OR (${leaveDateExpr} IS NOT NULL AND plr.requested_date = ${leaveDateExpr})
          )
        ORDER BY plr.requested_at DESC
        LIMIT 1
      ) leave_row ON TRUE
      LEFT JOIN users leave_reviewer ON leave_reviewer.user_id = leave_row.reviewed_by
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_pe ON pe.ward_id = sec_pe.sector_id
      LEFT JOIN wards w_pe ON pe.ward_id = w_pe.ward_id
      LEFT JOIN sectors sec_w_pe ON w_pe.sector_id = sec_w_pe.sector_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      LEFT JOIN sectors sec_wk ON wk.sector_id = sec_wk.sector_id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN sectors sec_w_req ON w_req.sector_id = sec_w_req.sector_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pa.ward_id = sec.sector_id
      LEFT JOIN wards w ON pa.ward_id = w.ward_id
      LEFT JOIN sectors sec_w ON w.sector_id = sec_w.sector_id
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      ORDER BY COALESCE(pa.date, leave_row.requested_date, DATE '1900-01-01') DESC, pe.full_name ASC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    const countQuery = `
      ${distinctCte}
      SELECT COUNT(*) as total
      FROM distinct_pe pe
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
    `;

    // Add LIMIT and OFFSET to params for the main query
    const mainParams = [...params, numericLimit, offset];

    const [dataResult, countResult] = await Promise.all([
      runQueryWithTimeout(query, mainParams),
      runQueryWithTimeout(countQuery, params)
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    const data = await Promise.all(
      dataResult.rows.map(async (row) => ({
        ...row,
        hours_worked: row.hours_worked == null ? '' : parseFloat(row.hours_worked).toFixed(2),
        punch_in_photo_url: row.punch_in_photo_url ? await getSignedS3Url(row.punch_in_photo_url, 900) : null,
        punch_out_photo_url: row.punch_out_photo_url ? await getSignedS3Url(row.punch_out_photo_url, 900) : null,
        profile_selfie_url: row.profile_selfie_url ? await getSignedS3Url(row.profile_selfie_url, 900) : null
      }))
    );

    res.json({
      success: true,
      data,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    logger.error('[ProfessionalReports] getAttendanceList error:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

/**
 * @desc    Get aggregated attendance summary
 * @route   GET /api/admin/professional-attendance/summary
 */
const getAttendanceSummary = async (req, res) => {
  try {
    await ensureAttendanceReportColumns();
    const { city_id, zone_id, ward_id, kothi_id, professional_id, date, month, start_date, end_date, search } = req.query;
    const dateRange = getValidatedDateRange(start_date, end_date);

    if (!dateRange && !date && (!month || !/^\d{4}-\d{2}$/.test(month))) {
      return res.status(400).json({
        success: false,
        message: "Provide either date (YYYY-MM-DD), month (YYYY-MM), or start_date/end_date (YYYY-MM-DD)."
      });
    }

    // CTE for professional scope to count and filter professionals accurately
    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    
    let peFilters = `AND ${whereClause} AND pe.is_active = true`;
    let peParamCount = params.length;

    if (search && String(search).trim()) {
      peParamCount++;
      const searchPattern = `%${String(search).trim()}%`;
      peFilters += `
        AND (
          pe.full_name ILIKE $${peParamCount}
          OR pe.emp_code ILIKE $${peParamCount}
          OR pe.mobile ILIKE $${peParamCount}
          OR pe.email ILIKE $${peParamCount}
          OR ${reviewedSearchSql('pe.id',`$${peParamCount}`)}
          OR z.zone_name ILIKE $${peParamCount}
          OR c.city_name ILIKE $${peParamCount}
          OR EXISTS (
            SELECT 1 FROM wards w_s WHERE w_s.ward_id = pe.ward_id AND w_s.ward_name ILIKE $${peParamCount}
          )
          OR EXISTS (
            SELECT 1 FROM sectors s_s WHERE s_s.sector_id = pe.ward_id AND s_s.sector_name ILIKE $${peParamCount}
          )
          OR EXISTS (
            SELECT 1 FROM wards k_s WHERE k_s.ward_id = pe.kothi_id AND k_s.ward_name ILIKE $${peParamCount}
          )
        )
      `;
      params.push(searchPattern);
    }

    if (city_id) { peParamCount++; peFilters += ` AND pe.city_id = $${peParamCount}`; params.push(city_id); }
    if (zone_id) { peParamCount++; peFilters += ` AND pe.zone_id = $${peParamCount}`; params.push(zone_id); }

    const geoFilters = buildWardAndKothiFilters(ward_id, kothi_id, peParamCount, params);
    peFilters += geoFilters.sql;
    peParamCount = geoFilters.paramCount;

    if (professional_id) { peParamCount++; peFilters += ` AND pe.id = $${peParamCount}`; params.push(professional_id); }

    // Date filters on professional_attendance (pa)
    let paFilters = '';
    let paParamCount = peParamCount;
    let paCheckJoin = '';
    let paCheckOrder = '';

    if (dateRange) {
      paParamCount++;
      const startIdx = paParamCount;
      params.push(dateRange.startDate);
      paParamCount++;
      const endIdx = paParamCount;
      params.push(dateRange.endDate);
      paFilters += ` AND pa.date >= $${startIdx} AND pa.date <= $${endIdx}`;
      paCheckJoin = `
        LEFT JOIN professional_attendance pa_check
          ON pa_check.professional_id = pe.id
         AND pa_check.date >= $${startIdx}::date
         AND pa_check.date <= $${endIdx}::date
      `;
      paCheckOrder = `CASE WHEN pa_check.punch_in IS NOT NULL THEN 0 ELSE 1 END,`;
    } else if (date) {
      paParamCount++;
      const dateIdx = paParamCount;
      params.push(date);
      paFilters += ` AND pa.date = $${dateIdx}`;
      paCheckJoin = `
        LEFT JOIN professional_attendance pa_check
          ON pa_check.professional_id = pe.id
         AND pa_check.date = $${dateIdx}::date
      `;
      paCheckOrder = `CASE WHEN pa_check.punch_in IS NOT NULL THEN 0 ELSE 1 END,`;
    } else {
      const [yyyy, mm] = month.split('-');
      paParamCount++;
      const yyyyIdx = paParamCount;
      params.push(yyyy);
      paParamCount++;
      const mmIdx = paParamCount;
      params.push(mm);
      paFilters += ` AND EXTRACT(YEAR FROM pa.date) = $${yyyyIdx} AND EXTRACT(MONTH FROM pa.date) = $${mmIdx}`;
      paCheckJoin = `
        LEFT JOIN professional_attendance pa_check
          ON pa_check.professional_id = pe.id
         AND EXTRACT(YEAR FROM pa_check.date) = $${yyyyIdx}
         AND EXTRACT(MONTH FROM pa_check.date) = $${mmIdx}
      `;
      paCheckOrder = `CASE WHEN pa_check.punch_in IS NOT NULL THEN 0 ELSE 1 END,`;
    }

    const distinctCte = `
      ${cte ? cte + ',' : 'WITH'} distinct_pe AS (
        SELECT DISTINCT ON (
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text)
        ) pe.*
        FROM professional_employees pe
        JOIN zones z ON pe.zone_id = z.zone_id
        JOIN cities c ON pe.city_id = c.city_id
        ${paCheckJoin}
        WHERE 1=1 ${peFilters}
        ORDER BY
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text),
          ${paCheckOrder}
          pe.created_at DESC
      )
    `;

    const peCountQuery = `
      ${distinctCte}
      SELECT COUNT(*) as total FROM distinct_pe pe
    `;

    // By Ward Aggregation
    const aggQuery = `
      ${distinctCte}
      SELECT
        COALESCE(
          sec_pe.sector_name,
          sec_w_pe.sector_name,
          sec_wk.sector_name,
          sec_req.sector_name,
          sec_w_req.sector_name,
          sec.sector_name,
          sec_w.sector_name,
          w_pe.ward_name,
          w_req.ward_name,
          w.ward_name
        ) AS ward_name,
        COUNT(DISTINCT pa.professional_id) as unique_professionals_present,
        COUNT(pa.id) as total_present_days
      FROM professional_attendance pa
      JOIN distinct_pe pe ON pa.professional_id = pe.id
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_pe ON pe.ward_id = sec_pe.sector_id
      LEFT JOIN wards w_pe ON pe.ward_id = w_pe.ward_id
      LEFT JOIN sectors sec_w_pe ON w_pe.sector_id = sec_w_pe.sector_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      LEFT JOIN sectors sec_wk ON wk.sector_id = sec_wk.sector_id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN sectors sec_w_req ON w_req.sector_id = sec_w_req.sector_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pa.ward_id = sec.sector_id
      LEFT JOIN wards w ON pa.ward_id = w.ward_id
      LEFT JOIN sectors sec_w ON w.sector_id = sec_w.sector_id
      WHERE 1=1 ${paFilters}
      GROUP BY COALESCE(
        sec_pe.sector_name,
        sec_w_pe.sector_name,
        sec_wk.sector_name,
        sec_req.sector_name,
        sec_w_req.sector_name,
        sec.sector_name,
        sec_w.sector_name,
        w_pe.ward_name,
        w_req.ward_name,
        w.ward_name
      )
      ORDER BY 1 ASC
    `;

    const presentProfessionalsQuery = `
      ${distinctCte}
      SELECT COUNT(DISTINCT pa.professional_id) AS total
      FROM professional_attendance pa
      JOIN distinct_pe pe ON pa.professional_id = pe.id
      WHERE pa.punch_in IS NOT NULL ${paFilters}
    `;

    const punchedOutProfessionalsQuery = `
      ${distinctCte}
      SELECT COUNT(DISTINCT pa.professional_id) AS total
      FROM professional_attendance pa
      JOIN distinct_pe pe ON pa.professional_id = pe.id
      WHERE pa.punch_in IS NOT NULL AND pa.punch_out IS NOT NULL ${paFilters}
    `;

    const punchedOutSystemProfessionalsQuery = `
      ${distinctCte}
      SELECT COUNT(DISTINCT pa.professional_id) AS total
      FROM professional_attendance pa
      JOIN distinct_pe pe ON pa.professional_id = pe.id
      WHERE pa.punch_in IS NOT NULL
        AND pa.punch_out IS NOT NULL
        AND (
          pa.auto_punched_out = true
          OR LOWER(COALESCE(pa.out_address, '')) LIKE '%auto punch%'
        ) ${paFilters}
    `;

    let leaveQuery = null;
    if (date) {
      const dateIdx = paParamCount;
      leaveQuery = `
        ${distinctCte}
        SELECT COUNT(DISTINCT plr.professional_id) AS total
        FROM professional_leave_requests plr
        JOIN distinct_pe pe ON plr.professional_id = pe.id
        WHERE plr.requested_date = $${dateIdx}
          AND plr.status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM professional_attendance pa
            WHERE pa.professional_id = plr.professional_id
              AND pa.date = $${dateIdx}
              AND pa.punch_in IS NOT NULL
          )
      `;
    }

    // Reuse the scoped/deduplicated employee set inside one database request.
    // Previously seven concurrent statements each rebuilt this same relation.
    const weeklyQuery = date ? `SELECT COUNT(*) FILTER(WHERE weekly_off) AS total,
      COUNT(*) FILTER(WHERE weekly_off AND NOT worked AND NOT on_leave) AS off_without_attendance,
      COUNT(*) FILTER(WHERE holiday) AS holiday_total,
      COUNT(*) FILTER(WHERE holiday AND NOT weekly_off AND NOT worked AND NOT on_leave) AS holiday_without_attendance
      FROM (SELECT pe.id,professional_is_week_off(pe.id,$${paParamCount}::date) AS weekly_off,
        EXISTS(SELECT 1 FROM professional_holidays h WHERE h.holiday_date=$${paParamCount}::date AND h.city_id=pe.city_id
          AND (h.zone_id IS NULL OR h.zone_id=pe.zone_id) AND (h.ward_id IS NULL OR h.ward_id=pe.ward_id) AND (h.kothi_id IS NULL OR h.kothi_id=pe.kothi_id)) AS holiday,
        EXISTS(SELECT 1 FROM professional_attendance a WHERE a.professional_id=pe.id AND a.date=$${paParamCount}::date AND a.punch_in IS NOT NULL) AS worked,
        EXISTS(SELECT 1 FROM professional_leave_requests l WHERE l.professional_id=pe.id AND l.requested_date=$${paParamCount}::date AND l.status='approved') AS on_leave
        FROM distinct_pe pe) flags` : 'SELECT 0 AS total,0 AS off_without_attendance,0 AS holiday_total,0 AS holiday_without_attendance';
    const withoutScope = query => query.replace(distinctCte, '');
    const combinedQuery = `${distinctCte},
      employee_count AS (${withoutScope(peCountQuery)}),
      ward_counts AS (${withoutScope(aggQuery)}),
      present_count AS (${withoutScope(presentProfessionalsQuery)}),
      punched_out_count AS (${withoutScope(punchedOutProfessionalsQuery)}),
      system_out_count AS (${withoutScope(punchedOutSystemProfessionalsQuery)}),
      leave_count AS (${leaveQuery ? withoutScope(leaveQuery) : 'SELECT 0 AS total'}),
      weekly_count AS (${weeklyQuery})
      SELECT (SELECT total FROM employee_count) AS total_professionals,
        COALESCE((SELECT json_agg(w) FROM ward_counts w),'[]'::json) AS by_ward,
        (SELECT total FROM present_count) AS present,
        (SELECT total FROM punched_out_count) AS punched_out,
        (SELECT total FROM system_out_count) AS system_out,
        (SELECT total FROM leave_count) AS leave,
        (SELECT row_to_json(w) FROM weekly_count w) AS weekly`;
    const combinedResult = await runQueryWithTimeout(combinedQuery, params);
    const counts = combinedResult.rows[0];
    const peCountResult = {rows:[{total:counts.total_professionals}]};
    const aggResult = {rows:counts.by_ward};
    const presentProfessionalsResult = {rows:[{total:counts.present}]};
    const punchedOutProfessionalsResult = {rows:[{total:counts.punched_out}]};
    const punchedOutSystemProfessionalsResult = {rows:[{total:counts.system_out}]};
    const leaveResult = {rows:[{total:counts.leave}]};
    const weeklyOffResult = {rows:[counts.weekly]};

    const totalProfessionals = parseInt(peCountResult.rows[0].total, 10);

    let totalPresentDays = 0;
    aggResult.rows.forEach(r => totalPresentDays += parseInt(r.total_present_days, 10));

    const uniquePresentProfessionals = parseInt(presentProfessionalsResult.rows?.[0]?.total || 0, 10);
    const totalPunchedOutProfessionals = parseInt(punchedOutProfessionalsResult.rows?.[0]?.total || 0, 10);
    const punchedOutSystemProfessionals = parseInt(punchedOutSystemProfessionalsResult.rows?.[0]?.total || 0, 10);
    const leaveProfessionals = parseInt(leaveResult.rows?.[0]?.total || 0, 10);
    const punchedOutProfessionals = Math.max(totalPunchedOutProfessionals - punchedOutSystemProfessionals, 0);
    const isToday = date === getTodayInIST();
    const notPunchedOutProfessionals = isToday
      ? punchedOutSystemProfessionals
      : Math.max(uniquePresentProfessionals - punchedOutProfessionals, 0);
    const inProgressProfessionals = isToday
      ? Math.max(uniquePresentProfessionals - totalPunchedOutProfessionals, 0)
      : 0;
    const weeklyOffProfessionals = Number(weeklyOffResult.rows[0]?.total || 0);
    const absentProfessionals = Math.max(totalProfessionals - uniquePresentProfessionals - leaveProfessionals - Number(weeklyOffResult.rows[0]?.off_without_attendance || 0) - Number(weeklyOffResult.rows[0]?.holiday_without_attendance || 0), 0);

    const avgRate = totalProfessionals > 0
      ? ((uniquePresentProfessionals / totalProfessionals) * 100).toFixed(2)
      : 0;

    res.json({
      success: true,
      data: {
        total_professionals: totalProfessionals,
        present_professionals: uniquePresentProfessionals,
        unique_present_professionals: uniquePresentProfessionals,
        leave_professionals: leaveProfessionals,
        absent_professionals: absentProfessionals,
        weekly_off_professionals: weeklyOffProfessionals,
        holiday_professionals: Number(weeklyOffResult.rows[0]?.holiday_total || 0),
        punched_out_professionals: totalPunchedOutProfessionals,
        manual_punched_out_professionals: punchedOutProfessionals,
        punched_out_system_professionals: punchedOutSystemProfessionals,
        not_punched_out_professionals: notPunchedOutProfessionals,
        in_progress_professionals: inProgressProfessionals,
        total_present_days: totalPresentDays,
        avg_attendance_rate: parseFloat(avgRate),
        by_ward: aggResult.rows
      }
    });

  } catch (error) {
    logger.error('[ProfessionalReports] getAttendanceSummary error:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

/**
 * @desc    Get attendance count by employee for a date range
 * @route   GET /api/admin/professional-attendance/date-range/summary
 */
const getDateRangeAttendanceSummary = async (req, res) => {
  try {
    await ensureAttendanceReportColumns();
    await ensureProfessionalLeaveSchema();
    const {
      city_id,
      zone_id,
      ward_id,
      kothi_id,
      professional_id,
      start_date,
      end_date,
      page = 1,
      limit = 20,
      search
    } = req.query;

    const dateRange = getValidatedDateRange(start_date, end_date);
    if (!dateRange) {
      return res.status(400).json({
        success: false,
        message: "start_date and end_date are required in YYYY-MM-DD format, and start_date must be <= end_date."
      });
    }

    const numericPage = Math.max(parseInt(page, 10) || 1, 1);
    const numericLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 10000);
    const offset = (numericPage - 1) * numericLimit;

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    let peFilters = `AND ${whereClause} AND pe.is_active = true`;
    let paramCount = params.length;

    if (search && String(search).trim()) {
      paramCount++;
      const searchPattern = `%${String(search).trim()}%`;
      peFilters += `
        AND (
          pe.full_name ILIKE $${paramCount}
          OR pe.emp_code ILIKE $${paramCount}
          OR pe.mobile ILIKE $${paramCount}
          OR pe.email ILIKE $${paramCount}
          OR ${reviewedSearchSql('pe.id',`$${paramCount}`)}
          OR z.zone_name ILIKE $${paramCount}
          OR c.city_name ILIKE $${paramCount}
          OR EXISTS (
            SELECT 1 FROM wards w_s WHERE w_s.ward_id = pe.ward_id AND w_s.ward_name ILIKE $${paramCount}
          )
          OR EXISTS (
            SELECT 1 FROM sectors s_s WHERE s_s.sector_id = pe.ward_id AND s_s.sector_name ILIKE $${paramCount}
          )
          OR EXISTS (
            SELECT 1 FROM wards k_s WHERE k_s.ward_id = pe.kothi_id AND k_s.ward_name ILIKE $${paramCount}
          )
        )
      `;
      params.push(searchPattern);
    }
    if (city_id) {
      paramCount++;
      peFilters += ` AND pe.city_id = $${paramCount}`;
      params.push(city_id);
    }
    if (zone_id) {
      paramCount++;
      peFilters += ` AND pe.zone_id = $${paramCount}`;
      params.push(zone_id);
    }

    const geoFilters = buildWardAndKothiFilters(ward_id, kothi_id, paramCount, params);
    peFilters += geoFilters.sql;
    paramCount = geoFilters.paramCount;

    if (professional_id) {
      paramCount++;
      peFilters += ` AND pe.id = $${paramCount}`;
      params.push(professional_id);
    }

    const startParam = paramCount + 1;
    const endParam = paramCount + 2;
    const pageParams = [dateRange.startDate, dateRange.endDate, numericLimit, offset];

    const distinctCte = `
      ${cte ? cte + ',' : 'WITH'} distinct_pe AS (
        SELECT DISTINCT ON (
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text)
        ) pe.*
        FROM professional_employees pe
        JOIN zones z ON pe.zone_id = z.zone_id
        JOIN cities c ON pe.city_id = c.city_id
        LEFT JOIN professional_attendance pa_check
          ON pa_check.professional_id = pe.id
         AND pa_check.date >= $${startParam}::date
         AND pa_check.date <= $${endParam}::date
        WHERE 1=1 ${peFilters}
        ORDER BY
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text),
          CASE WHEN pa_check.punch_in IS NOT NULL THEN 0 ELSE 1 END,
          pe.created_at DESC
      )
    `;

    const dataQuery = `
      ${distinctCte}
      SELECT
        pe.id AS professional_id,
        pe.full_name,
        pe.emp_code,
        pe.mobile,
        pe.email,
        COALESCE(
          sec_pe.sector_name,
          sec_w_pe.sector_name,
          sec_wk.sector_name,
          sec_req.sector_name,
          sec_w_req.sector_name,
          sec.sector_name,
          sec_w.sector_name,
          w_pe.ward_name,
          w_req.ward_name,
          w.ward_name
        ) AS ward_name,
        COALESCE(
          wk.ward_name,
          wk_req.ward_name,
          w_pe.ward_name,
          w_req.ward_name,
          w.ward_name,
          sec_pe.sector_name
        ) AS kothi_name,
        z.zone_name,
        c.city_name,

        -- Attendance & leave
        COUNT(pa.id) FILTER (WHERE pa.punch_in IS NOT NULL) AS attendance_count,
        COALESCE(leave_agg.leave_days, 0) AS leave_days,
        leave_agg.latest_reviewer_name AS leave_reviewed_by_name,
        COUNT(pa.id) FILTER (
          WHERE pa.punch_in IS NOT NULL
            AND pa.punch_out IS NOT NULL
            AND COALESCE(pa.auto_punched_out, false) = false
            AND LOWER(COALESCE(pa.out_address, '')) NOT LIKE '%auto punch%'
        ) AS completed_days,
        COUNT(pa.id) FILTER (
          WHERE pa.punch_in IS NOT NULL
            AND (
              pa.punch_out IS NULL
              OR COALESCE(pa.auto_punched_out, false) = true
              OR LOWER(COALESCE(pa.out_address, '')) LIKE '%auto punch%'
            )
        ) AS not_punched_out_days,
        ROUND(
          COALESCE(
            SUM(
              CASE
                WHEN pa.punch_in IS NOT NULL AND pa.punch_out IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (pa.punch_out - pa.punch_in)) / 3600
                ELSE 0
              END
            ),
            0
          )::numeric,
          2
        ) AS total_hours_worked,

        -- Total calendar days in selected range
        ($${endParam}::date - $${startParam}::date + 1) AS total_range_days,

        -- Week off days: count calendar days in range that fall on the employee's configured week-off day numbers
        COALESCE(weekoff_agg.week_off_count, 0) AS week_off_days_count,
        weekoff_agg.payable_days AS calendar_payable_days,

        -- Holiday days: scoped by location and excluding configured week-offs
        COALESCE(holiday_agg.holiday_days, 0) AS holiday_days,

        -- Working days = total range days - week off days
        ($${endParam}::date - $${startParam}::date + 1) - COALESCE(weekoff_agg.week_off_count, 0) AS working_days

      FROM distinct_pe pe
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      LEFT JOIN professional_attendance pa
        ON pa.professional_id = pe.id
       AND pa.date >= $${startParam}
       AND pa.date <= $${endParam}
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE plr.status = 'approved') AS leave_days,
          MAX(COALESCE((SELECT full_name FROM professional_employees WHERE id=plr.hod_reviewer_id),
          (SELECT full_name FROM professional_employees WHERE id=plr.ho_reviewer_id),
            (SELECT full_name FROM professional_employees WHERE id=plr.pm_reviewer_id),u.name)) AS latest_reviewer_name
        FROM professional_leave_requests plr
        LEFT JOIN users u ON u.user_id = plr.reviewed_by
        WHERE plr.professional_id = pe.id
          AND plr.requested_date >= $${startParam}
          AND plr.requested_date <= $${endParam}
      ) leave_agg ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(gs.d) FILTER (WHERE professional_is_week_off(pe.id,gs.d::date)) AS week_off_count,
          COUNT(gs.d) FILTER (WHERE ${reviewedPaidDaySql('pe.id','gs.d::date')}) AS payable_days
        FROM generate_series($${startParam}::date, $${endParam}::date, INTERVAL '1 day') AS gs(d)
      ) weekoff_agg ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT h.holiday_date)::int AS holiday_days
        FROM professional_holidays h
        WHERE h.holiday_date >= $${startParam}
          AND h.holiday_date <= $${endParam}
          AND h.city_id = pe.city_id
          AND (h.zone_id IS NULL OR h.zone_id = pe.zone_id)
          AND (h.ward_id IS NULL OR h.ward_id = pe.ward_id)
          AND (h.kothi_id IS NULL OR h.kothi_id = pe.kothi_id)
          AND NOT professional_is_week_off(pe.id,h.holiday_date)
      ) holiday_agg ON TRUE
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_pe ON pe.ward_id = sec_pe.sector_id
      LEFT JOIN wards w_pe ON pe.ward_id = w_pe.ward_id
      LEFT JOIN sectors sec_w_pe ON w_pe.sector_id = sec_w_pe.sector_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      LEFT JOIN sectors sec_wk ON wk.sector_id = sec_wk.sector_id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN sectors sec_w_req ON w_req.sector_id = sec_w_req.sector_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pa.ward_id = sec.sector_id
      LEFT JOIN wards w ON pa.ward_id = w.ward_id
      LEFT JOIN sectors sec_w ON w.sector_id = sec_w.sector_id
      GROUP BY pe.id, pe.full_name, pe.emp_code, pe.mobile, pe.email,
               COALESCE(
                 sec_pe.sector_name,
                 sec_w_pe.sector_name,
                 sec_wk.sector_name,
                 sec_req.sector_name,
                 sec_w_req.sector_name,
                 sec.sector_name,
                 sec_w.sector_name,
                 w_pe.ward_name,
                 w_req.ward_name,
                 w.ward_name
               ),
               COALESCE(
                 wk.ward_name,
                 wk_req.ward_name,
                 w_pe.ward_name,
                 w_req.ward_name,
                 w.ward_name,
                 sec_pe.sector_name
               ),
               z.zone_name, c.city_name,
               leave_agg.leave_days, leave_agg.latest_reviewer_name,
               weekoff_agg.week_off_count, weekoff_agg.payable_days, holiday_agg.holiday_days
      ORDER BY (COUNT(pa.id) + COALESCE(leave_agg.leave_days, 0) + COALESCE(holiday_agg.holiday_days, 0)) DESC, pe.full_name ASC
      LIMIT $${startParam + 2} OFFSET $${startParam + 3}
    `;

    const countQuery = `
      ${distinctCte}
      SELECT COUNT(*) AS total
      FROM distinct_pe pe
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
    `;

    const finalParams = [...params, ...pageParams];
    const countParams = [...params, dateRange.startDate, dateRange.endDate];

    const [dataResult, countResult] = await Promise.all([
      runQueryWithTimeout(dataQuery, finalParams),
      runQueryWithTimeout(countQuery, countParams)
    ]);

    const total = parseInt(countResult.rows?.[0]?.total || 0, 10);

    res.json({
      success: true,
      data: dataResult.rows.map((row) => {
        const attendanceDays  = parseInt(row.attendance_count || 0, 10);
        const leaveDays       = parseInt(row.leave_days || 0, 10);
        const completedDays   = parseInt(row.completed_days || 0, 10);
        const notPunchedOutDays = parseInt(row.not_punched_out_days || 0, 10);
        const totalRangeDays  = parseInt(row.total_range_days || 0, 10);
        const weekOffDays     = parseInt(row.week_off_days_count || 0, 10);
        const holidayDays     = parseInt(row.holiday_days || 0, 10);
        const workingDays     = parseInt(row.working_days || 0, 10);
        // Half day also counted as full for salary purposes (attendance_count = any punch-in)
        const effectivePresent = attendanceDays + leaveDays;
        const adjustedPresent  = effectivePresent + holidayDays;
        const payableDays = Number(row.calendar_payable_days || 0);
        const absentDays = Math.max(totalRangeDays - payableDays, 0);
        // Payable days include configured week off days as paid days.

        return {
          ...row,
          attendance_count:        attendanceDays,
          leave_days:              leaveDays,
          leave_reviewed_by_name:  row.leave_reviewed_by_name || null,
          completed_days:          completedDays,
          not_punched_out_days:    notPunchedOutDays,
          total_hours_worked:      parseFloat(row.total_hours_worked || 0).toFixed(2),
          total_range_days:        totalRangeDays,
          week_off_days_count:     weekOffDays,
          holiday_days:            holidayDays,
          working_days:            workingDays,
          effective_present:       effectivePresent,
          absent_days:             absentDays,
          payable_days:            payableDays,
        };
      }),
      pagination: {
        page: numericPage,
        limit: numericLimit,
        total,
        pages: Math.max(1, Math.ceil(total / numericLimit))
      }
    });
  } catch (error) {
    logger.error('[ProfessionalReports] getDateRangeAttendanceSummary error:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};


/**
 * @desc    Get day-wise attendance details for one employee in date range
 * @route   GET /api/admin/professional-attendance/date-range/details
 */
const getDateRangeAttendanceDetails = async (req, res) => {
  try {
    await ensureAttendanceReportColumns();
    await ensureProfessionalLeaveSchema();
    const { professional_id, start_date, end_date } = req.query;
    const dateRange = getValidatedDateRange(start_date, end_date);

    if (!professional_id) {
      return res.status(400).json({ success: false, message: "professional_id is required." });
    }
    if (!dateRange) {
      return res.status(400).json({
        success: false,
        message: "start_date and end_date are required in YYYY-MM-DD format, and start_date must be <= end_date."
      });
    }

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    const verifyParams = [...params, professional_id];
    const verifyQuery = `
      ${cte}
      SELECT
        pe.id,
        pe.full_name
      FROM professional_employees pe
      WHERE pe.id = $${verifyParams.length}
        AND pe.is_active = true
        AND ${whereClause}
      LIMIT 1
    `;

    const verifyResult = await runQueryWithTimeout(verifyQuery, verifyParams);
    if (verifyResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Employee not found or access denied." });
    }

    const detailsQuery = `
      WITH calendar_days AS (
        SELECT gs::date AS date
        FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS gs
      )
      SELECT
        pa.id AS attendance_id,
        pe.id AS professional_id,
        pe.full_name,
        pe.emp_code,
        cd.date,
        professional_is_week_off(pe.id,cd.date) AS is_weekly_off,
        EXISTS(SELECT 1 FROM professional_holidays h WHERE h.holiday_date=cd.date AND h.city_id=pe.city_id
          AND (h.zone_id IS NULL OR h.zone_id=pe.zone_id) AND (h.ward_id IS NULL OR h.ward_id=pe.ward_id) AND (h.kothi_id IS NULL OR h.kothi_id=pe.kothi_id)) AS is_holiday,
        ${reviewedPaidDaySql('pe.id','cd.date')} AS is_payable_day,
        pa.punch_in, pa.attempted_punch_in, pa.punch_approval_status,
        pa.punch_out,
        pa.auto_punched_out,
        pa.auto_punched_out AS is_auto_punch_out,
        pa.out_address,
        CASE
          WHEN pa.punch_in IS NULL OR pa.punch_out IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (pa.punch_out - pa.punch_in)) / 3600
        END AS hours_worked,
        pa.punch_in_latitude,
        pa.punch_in_longitude,
        pa.punch_out_latitude,
        pa.punch_out_longitude,
        pa.punch_in_photo_url,
        pa.punch_out_photo_url,
        plr.leave_type,
        plr.status AS leave_status,
        plr.review_note AS leave_review_note,
        plr.reviewed_at AS leave_reviewed_at,
        COALESCE((SELECT full_name FROM professional_employees WHERE id=plr.hod_reviewer_id),
          (SELECT full_name FROM professional_employees WHERE id=plr.ho_reviewer_id),
          (SELECT full_name FROM professional_employees WHERE id=plr.pm_reviewer_id),leave_reviewer.name) AS leave_reviewed_by_name,
        COALESCE(
          sec_pe.sector_name,
          sec_w_pe.sector_name,
          sec_wk.sector_name,
          sec_req.sector_name,
          sec_w_req.sector_name,
          sec.sector_name,
          sec_w.sector_name,
          w_pe.ward_name,
          w_req.ward_name,
          w.ward_name
        ) AS ward_name,
        COALESCE(
          wk.ward_name,
          wk_req.ward_name,
          w_pe.ward_name,
          w_req.ward_name,
          w.ward_name,
          sec_pe.sector_name
        ) AS kothi_name,
        z.zone_name,
        c.city_name
      FROM calendar_days cd
      JOIN professional_employees pe ON pe.id = $1
      LEFT JOIN professional_attendance pa
        ON pa.professional_id = pe.id
       AND pa.date = cd.date
      LEFT JOIN professional_leave_requests plr
        ON plr.professional_id = pe.id
       AND plr.requested_date = cd.date
      LEFT JOIN users leave_reviewer ON leave_reviewer.user_id = plr.reviewed_by
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_pe ON pe.ward_id = sec_pe.sector_id
      LEFT JOIN wards w_pe ON pe.ward_id = w_pe.ward_id
      LEFT JOIN sectors sec_w_pe ON w_pe.sector_id = sec_w_pe.sector_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      LEFT JOIN sectors sec_wk ON wk.sector_id = sec_wk.sector_id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN sectors sec_w_req ON w_req.sector_id = sec_w_req.sector_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pa.ward_id = sec.sector_id
      LEFT JOIN wards w ON pa.ward_id = w.ward_id
      LEFT JOIN sectors sec_w ON w.sector_id = sec_w.sector_id
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      ORDER BY cd.date DESC, pa.punch_in DESC NULLS LAST
    `;

    const detailsResult = await runQueryWithTimeout(detailsQuery, [
      professional_id,
      dateRange.startDate,
      dateRange.endDate
    ]);

    const shouldSignPhotos = req.query.include_photos === 'true' || detailsResult.rows.length <= 31;
    const mappedRows = await Promise.all(
      detailsResult.rows.map(async (row) => ({
        ...row,
        hours_worked: row.hours_worked == null ? '' : parseFloat(row.hours_worked).toFixed(2),
        punch_in_photo_url: row.punch_in_photo_url && shouldSignPhotos ? await getSignedS3Url(row.punch_in_photo_url, 900) : (row.punch_in_photo_url || null),
        punch_out_photo_url: row.punch_out_photo_url && shouldSignPhotos ? await getSignedS3Url(row.punch_out_photo_url, 900) : (row.punch_out_photo_url || null)
      }))
    );

    const isAutoPunchOut = (item) => (
      item.auto_punched_out === true
      || String(item.auto_punched_out || '').toLowerCase() === 'true'
      || String(item.out_address || '').toLowerCase().includes('auto punch')
    );
    const totalDays = mappedRows.length;
    const attendanceDays = mappedRows.filter((item) => item.punch_in).length;
    const completedDays = mappedRows.filter(
      (item) => item.punch_in && item.punch_out && !isAutoPunchOut(item)
    ).length;
    const notPunchedOutDays = mappedRows.filter(
      (item) => item.punch_in && (!item.punch_out || isAutoPunchOut(item))
    ).length;
    const totalHours = mappedRows.reduce((acc, item) => acc + (parseFloat(item.hours_worked) || 0), 0);
    const leaveApprovedDays = mappedRows.filter((item) => item.leave_status === "approved").length;
    const leavePendingDays = mappedRows.filter((item) => item.leave_status === "pending").length;

    res.json({
      success: true,
      data: {
        professional_id,
        professional_name: verifyResult.rows[0].full_name,
        start_date: dateRange.startDate,
        end_date: dateRange.endDate,
        total_days: totalDays,
        attendance_days: attendanceDays,
        completed_days: completedDays,
        not_punched_out_days: notPunchedOutDays,
        leave_approved_days: leaveApprovedDays,
        leave_pending_days: leavePendingDays,
        weekly_off_days: mappedRows.filter(r => r.is_weekly_off).length,
        payable_days: mappedRows.filter(r => r.is_payable_day).length,
        total_hours_worked: totalHours.toFixed(2),
        records: mappedRows
      }
    });
  } catch (error) {
    logger.error('[ProfessionalReports] getDateRangeAttendanceDetails error:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

/**
 * @desc    Get list of all professional employees
 * @route   GET /api/admin/professional-employees
 */
const getEmployeesList = async (req, res) => {
  try {
    const { city_id, zone_id, ward_id, kothi_id, page = 1, limit = 50, search } = req.query;
    const numericLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 10000);
    const numericPage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (numericPage - 1) * numericLimit;

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    
    let filters = `AND ${whereClause}`;
    let paramCount = params.length;

    if (search && String(search).trim()) {
      paramCount++;
      const searchPattern = `%${String(search).trim()}%`;
      filters += `
        AND (
          pe.full_name ILIKE $${paramCount}
          OR pe.emp_code ILIKE $${paramCount}
          OR pe.mobile ILIKE $${paramCount}
          OR pe.email ILIKE $${paramCount}
          OR ${reviewedSearchSql('pe.id',`$${paramCount}`)}
          OR z.zone_name ILIKE $${paramCount}
          OR c.city_name ILIKE $${paramCount}
          OR EXISTS (
            SELECT 1 FROM wards w_s WHERE w_s.ward_id = pe.ward_id AND w_s.ward_name ILIKE $${paramCount}
          )
          OR EXISTS (
            SELECT 1 FROM sectors s_s WHERE s_s.sector_id = pe.ward_id AND s_s.sector_name ILIKE $${paramCount}
          )
          OR EXISTS (
            SELECT 1 FROM wards k_s WHERE k_s.ward_id = pe.kothi_id AND k_s.ward_name ILIKE $${paramCount}
          )
        )
      `;
      params.push(searchPattern);
    }
    if (city_id) {
      paramCount++;
      filters += ` AND pe.city_id = $${paramCount}`;
      params.push(city_id);
    }
    if (zone_id) {
      paramCount++;
      filters += ` AND pe.zone_id = $${paramCount}`;
      params.push(zone_id);
    }

    const geoFilters = buildWardAndKothiFilters(ward_id, kothi_id, paramCount, params);
    filters += geoFilters.sql;
    paramCount = geoFilters.paramCount;

    const distinctCte = `
      ${cte ? cte + ',' : 'WITH'} distinct_pe AS (
        SELECT DISTINCT ON (
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text)
        ) pe.*
        FROM professional_employees pe
        JOIN zones z ON pe.zone_id = z.zone_id
        JOIN cities c ON pe.city_id = c.city_id
        WHERE 1=1 ${filters}
        ORDER BY
          COALESCE(NULLIF(TRIM(pe.mobile), ''), NULLIF(TRIM(pe.emp_code), ''), pe.id::text),
          pe.created_at DESC
      )
    `;

    const query = `
      ${distinctCte}
      SELECT
        pe.id, pe.full_name as name, pe.emp_code, pe.mobile, pe.is_active, pe.face_locked, pe.created_at,
        COALESCE(
          sec_pe.sector_name,
          sec_w_pe.sector_name,
          sec_wk.sector_name,
          sec_req.sector_name,
          sec_w_req.sector_name,
          w_pe.ward_name,
          w_req.ward_name
        ) AS ward_name,
        z.zone_name, c.city_name,
        COALESCE(
          wk.ward_name,
          wk_req.ward_name,
          w_pe.ward_name,
          w_req.ward_name,
          sec_pe.sector_name
        ) as kothi_name
      FROM distinct_pe pe
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_pe ON pe.ward_id = sec_pe.sector_id
      LEFT JOIN wards w_pe ON pe.ward_id = w_pe.ward_id
      LEFT JOIN sectors sec_w_pe ON w_pe.sector_id = sec_w_pe.sector_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      LEFT JOIN sectors sec_wk ON wk.sector_id = sec_wk.sector_id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN sectors sec_w_req ON w_req.sector_id = sec_w_req.sector_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      ORDER BY pe.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    const countQuery = `
      ${distinctCte}
      SELECT COUNT(*) as total FROM distinct_pe pe
    `;

    const mainParams = [...params, limit, offset];

    const [dataResult, countResult] = await Promise.all([
      runQueryWithTimeout(query, mainParams),
      runQueryWithTimeout(countQuery, params)
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    logger.error('[ProfessionalReports] getEmployeesList error:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

/**
 * @desc    Get monthly attendance for a specific professional employee
 * @route   GET /api/admin/professional-employees/:id/attendance
 */
const getEmployeeAttendance = async (req, res) => {
  try {
    await ensureAttendanceReportColumns();
    const { id } = req.params;
    let { month } = req.query;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      const d = new Date();
      month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    const [yyyy, mm] = month.split('-');

    // Verify visibility access to this specific employee first
    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    const peParams = [...params, id];
    
    const verifyQuery = `
      ${cte}
      SELECT id FROM professional_employees pe 
      WHERE pe.id = $${peParams.length} AND ${whereClause}
    `;

    const verifyResult = await runQueryWithTimeout(verifyQuery, peParams);
    
    if (verifyResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found or access denied.' });
    }

    // Include every calendar date so monthly consumers can render paid weekly offs.
    const query = `
      SELECT 
        d::date AS date, a.punch_in, a.punch_out, a.attempted_punch_in, a.punch_approval_status,
        professional_is_week_off($1,d::date) AS is_weekly_off,
        EXISTS(SELECT 1 FROM professional_holidays h JOIN professional_employees p ON p.id=$1 WHERE h.holiday_date=d::date AND h.city_id=p.city_id
          AND (h.zone_id IS NULL OR h.zone_id=p.zone_id) AND (h.ward_id IS NULL OR h.ward_id=p.ward_id) AND (h.kothi_id IS NULL OR h.kothi_id=p.kothi_id)) AS is_holiday,
        ${reviewedPaidDaySql('$1','d::date')} AS is_payable_day,
        CASE WHEN a.punch_in IS NULL OR (a.punch_out IS NULL AND d::date < CURRENT_DATE) THEN NULL ELSE EXTRACT(EPOCH FROM (COALESCE(a.punch_out, NOW()) - a.punch_in)) / 3600 END AS hours_worked
      FROM generate_series(make_date($2::int,$3::int,1),(make_date($2::int,$3::int,1)+INTERVAL '1 month - 1 day')::date,INTERVAL '1 day') d
      LEFT JOIN professional_attendance a ON a.professional_id=$1 AND a.date=d::date
      ORDER BY d DESC
    `;

    const attResult = await runQueryWithTimeout(query, [id, yyyy, mm]);

    res.json({
      success: true,
      data: attResult.rows.map(row => ({
        ...row,
        hours_worked: row.hours_worked == null ? '-' : parseFloat(row.hours_worked).toFixed(2),
        status: row.punch_approval_status==='rejected' ? 'punch-not-accepted' : ['pending_pm','pending_ho','pending_hod'].includes(row.punch_approval_status) ? 'in-consideration' : row.punch_in ? (row.punch_out && parseFloat(row.hours_worked) < 4 ? 'half-day' : 'present') : (row.is_holiday ? 'holiday' : row.is_weekly_off ? 'weekly-off' : 'absent')
      }))
    });

  } catch (error) {
    logger.error('[ProfessionalReports] getEmployeeAttendance error:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

module.exports = {
  getAttendanceList,
  getAttendanceSummary,
  getDateRangeAttendanceSummary,
  getDateRangeAttendanceDetails,
  getEmployeesList,
  getEmployeeAttendance
};
