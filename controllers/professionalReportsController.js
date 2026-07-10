const { runQueryWithTimeout } = require('../utils/queryRunner');
const { buildVisibilityScope } = require('../utils/professionalAccess');
const { getSignedS3Url } = require('../utils/s3SelfPunch');
const logger = require('../utils/logger');
const pool = require('../config/db');
const { ensureProfessionalLeaveSchema } = require('../utils/professionalLeaveSchema');

let attendanceReportColumnsEnsured = false;
const ensureAttendanceReportColumns = async () => {
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

const getValidatedDateRange = (startDate, endDate) => {
  if (!startDate || !endDate) return null;
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return null;
  if (startDate > endDate) return null;
  return { startDate, endDate };
};

/**
 * @desc    Get paginated list of professional attendance
 * @route   GET /api/admin/professional-attendance
 */
const getAttendanceList = async (req, res) => {
  try {
    await ensureAttendanceReportColumns();
    await ensureProfessionalLeaveSchema();
    await ensureProfessionalLeaveSchema();
    const { city_id, zone_id, ward_id, kothi_id, professional_id, date, month, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    
    let peFilters = `AND ${whereClause} AND pe.is_active = true`;
    let paramCount = params.length;
    let paFilters = '';
    let leaveDateParamIndex = null;

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
    if (ward_id) {
      paramCount++;
      peFilters += `
        AND (
          pe.ward_id = $${paramCount}
          OR EXISTS (
            SELECT 1
            FROM wards w_filter
            WHERE w_filter.ward_id = $${paramCount}
              AND w_filter.sector_id = pe.ward_id
          )
        )
      `;
      params.push(ward_id);
    }
    if (kothi_id) {
      paramCount++;
      peFilters += ` AND pe.kothi_id = $${paramCount}`;
      params.push(kothi_id);
    }
    if (professional_id) {
      paramCount++;
      peFilters += ` AND pe.id = $${paramCount}`;
      params.push(professional_id);
    }

    // Count query is based only on professional filters (not date/month attendance filters)
    const countParams = [...params];

    if (date) {
      paramCount++;
      paFilters += ` AND pa.date = $${paramCount}`;
      params.push(date);
      leaveDateParamIndex = paramCount;
    } else if (month) {
      // YYYY-MM format
      const [yyyy, mm] = month.split('-');
      paramCount++;
      paFilters += ` AND EXTRACT(YEAR FROM pa.date) = $${paramCount}`;
      params.push(yyyy);
      paramCount++;
      paFilters += ` AND EXTRACT(MONTH FROM pa.date) = $${paramCount}`;
      params.push(mm);
    }

    const leaveDateExpr = leaveDateParamIndex ? `$${leaveDateParamIndex}::date` : "NULL::date";
    const query = `
      ${cte}
      SELECT
        pa.id as attendance_id,
        pe.id as professional_id,
        pe.full_name,
        pe.emp_code,
        pe.mobile,
        pe.email,
        COALESCE(pa.date, leave_row.requested_date) as date,
        pa.punch_in,
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
        leave_reviewer.name AS leave_reviewed_by_name,
        pe.selfie_url as profile_selfie_url,
        COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name) AS ward_name,
        COALESCE(wk_req.ward_name, wk.ward_name) as kothi_name,
        z.zone_name,
        c.city_name
      FROM professional_employees pe
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
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pa.ward_id = sec.sector_id
      LEFT JOIN wards w ON pa.ward_id = w.ward_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      WHERE 1=1 ${peFilters}
      ORDER BY COALESCE(pa.date, leave_row.requested_date, DATE '1900-01-01') DESC, pe.full_name ASC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    const countQuery = `
      ${cte}
      SELECT COUNT(*) as total
      FROM professional_employees pe
      WHERE 1=1 ${peFilters}
    `;

    // Add LIMIT and OFFSET to params for the main query
    const mainParams = [...params, limit, offset];

    const [dataResult, countResult] = await Promise.all([
      runQueryWithTimeout(query, mainParams),
      runQueryWithTimeout(countQuery, countParams)
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
    const { city_id, zone_id, ward_id, kothi_id, professional_id, date, month, start_date, end_date } = req.query;
    const dateRange = getValidatedDateRange(start_date, end_date);

    if (!dateRange && !date && (!month || !/^\d{4}-\d{2}$/.test(month))) {
      return res.status(400).json({
        success: false,
        message: "Provide either date (YYYY-MM-DD), month (YYYY-MM), or start_date/end_date (YYYY-MM-DD)."
      });
    }

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pa');
    
    let filters = `AND ${whereClause} AND pa.professional_id IN (SELECT id FROM professional_employees WHERE is_active = true)`;
    let paramCount = params.length;
    
    if (dateRange) {
      paramCount++;
      filters += ` AND pa.date >= $${paramCount}`;
      params.push(dateRange.startDate);
      paramCount++;
      filters += ` AND pa.date <= $${paramCount}`;
      params.push(dateRange.endDate);
    } else if (date) {
      paramCount++;
      filters += ` AND pa.date = $${paramCount}`;
      params.push(date);
    } else {
      const [yyyy, mm] = month.split('-');
      paramCount++;
      filters += ` AND EXTRACT(YEAR FROM pa.date) = $${paramCount}`;
      params.push(yyyy);
      paramCount++;
      filters += ` AND EXTRACT(MONTH FROM pa.date) = $${paramCount}`;
      params.push(mm);
    }

    if (city_id) {
      paramCount++;
      filters += ` AND pa.city_id = $${paramCount}`;
      params.push(city_id);
    }
    if (zone_id) {
      paramCount++;
      filters += ` AND pa.zone_id = $${paramCount}`;
      params.push(zone_id);
    }
    if (ward_id) {
      paramCount++;
      filters += `
        AND (
          pa.ward_id = $${paramCount}
          OR EXISTS (
            SELECT 1
            FROM wards w_filter
            WHERE w_filter.ward_id = $${paramCount}
              AND w_filter.sector_id = pa.ward_id
          )
        )
      `;
      params.push(ward_id);
    }
    if (professional_id) {
      paramCount++;
      filters += ` AND pa.professional_id = $${paramCount}`;
      params.push(professional_id);
    }
    if (kothi_id) {
      paramCount++;
      filters += ` AND pa.professional_id IN (SELECT id FROM professional_employees WHERE kothi_id = $${paramCount})`;
      params.push(kothi_id);
    }

    // CTE for professional scope to count total professionals accurately
    const { cte: peCte, whereClause: peWhere, params: peParams } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    
    // Total professionals count
    let peFilters = `AND ${peWhere} AND pe.is_active = true`;
    let peParamCount = peParams.length;
    
    if (city_id) { peParamCount++; peFilters += ` AND pe.city_id = $${peParamCount}`; peParams.push(city_id); }
    if (zone_id) { peParamCount++; peFilters += ` AND pe.zone_id = $${peParamCount}`; peParams.push(zone_id); }
    if (ward_id) {
      peParamCount++;
      peFilters += `
        AND (
          pe.ward_id = $${peParamCount}
          OR EXISTS (
            SELECT 1
            FROM wards w_filter
            WHERE w_filter.ward_id = $${peParamCount}
              AND w_filter.sector_id = pe.ward_id
          )
        )
      `;
      peParams.push(ward_id);
    }
    if (kothi_id) { peParamCount++; peFilters += ` AND pe.kothi_id = $${peParamCount}`; peParams.push(kothi_id); }
    if (professional_id) { peParamCount++; peFilters += ` AND pe.id = $${peParamCount}`; peParams.push(professional_id); }

    const peCountQuery = `
      ${peCte}
      SELECT COUNT(*) as total FROM professional_employees pe WHERE 1=1 ${peFilters}
    `;

    // By Ward Aggregation
    const aggQuery = `
      ${cte}
      SELECT
        COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name) AS ward_name,
        COUNT(DISTINCT pa.professional_id) as unique_professionals_present,
        COUNT(pa.id) as total_present_days
      FROM professional_attendance pa
      JOIN professional_employees pe ON pa.professional_id = pe.id
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN sectors sec ON pa.ward_id = sec.sector_id
      LEFT JOIN wards w ON pa.ward_id = w.ward_id
      WHERE 1=1 ${filters}
      GROUP BY COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name)
      ORDER BY COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name) ASC
    `;

    const presentProfessionalsQuery = `
      ${cte}
      SELECT COUNT(DISTINCT pa.professional_id) AS total
      FROM professional_attendance pa
      WHERE 1=1 ${filters}
    `;

    const [peCountResult, aggResult, presentProfessionalsResult] = await Promise.all([
      runQueryWithTimeout(peCountQuery, peParams),
      runQueryWithTimeout(aggQuery, params),
      runQueryWithTimeout(presentProfessionalsQuery, params)
    ]);

    const totalProfessionals = parseInt(peCountResult.rows[0].total, 10);
    
    let totalPresentDays = 0;
    aggResult.rows.forEach(r => totalPresentDays += parseInt(r.total_present_days, 10));

    const uniquePresentProfessionals = parseInt(presentProfessionalsResult.rows?.[0]?.total || 0, 10);
    const avgRate = totalProfessionals > 0
      ? ((uniquePresentProfessionals / totalProfessionals) * 100).toFixed(2)
      : 0;

    res.json({
      success: true,
      data: {
        total_professionals: totalProfessionals,
        unique_present_professionals: uniquePresentProfessionals,
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
      limit = 20
    } = req.query;

    const dateRange = getValidatedDateRange(start_date, end_date);
    if (!dateRange) {
      return res.status(400).json({
        success: false,
        message: "start_date and end_date are required in YYYY-MM-DD format, and start_date must be <= end_date."
      });
    }

    const numericPage = Math.max(parseInt(page, 10) || 1, 1);
    const numericLimit = Math.max(parseInt(limit, 10) || 20, 1);
    const offset = (numericPage - 1) * numericLimit;

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    let peFilters = `AND ${whereClause} AND pe.is_active = true`;
    let paramCount = params.length;

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
    if (ward_id) {
      paramCount++;
      peFilters += `
        AND (
          pe.ward_id = $${paramCount}
          OR EXISTS (
            SELECT 1
            FROM wards w_filter
            WHERE w_filter.ward_id = $${paramCount}
              AND w_filter.sector_id = pe.ward_id
          )
        )
      `;
      params.push(ward_id);
    }
    if (kothi_id) {
      paramCount++;
      peFilters += ` AND pe.kothi_id = $${paramCount}`;
      params.push(kothi_id);
    }
    if (professional_id) {
      paramCount++;
      peFilters += ` AND pe.id = $${paramCount}`;
      params.push(professional_id);
    }

    const startParam = paramCount + 1;
    const endParam = paramCount + 2;
    const pageParams = [dateRange.startDate, dateRange.endDate, numericLimit, offset];

    const dataQuery = `
      ${cte}
      SELECT
        pe.id AS professional_id,
        pe.full_name,
        pe.emp_code,
        pe.mobile,
        pe.email,
        COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name) AS ward_name,
        COALESCE(wk_req.ward_name, wk.ward_name) as kothi_name,
        z.zone_name,
        c.city_name,

        -- Attendance & leave
        COUNT(pa.id) AS attendance_count,
        COALESCE(leave_agg.leave_days, 0) AS leave_days,
        leave_agg.latest_reviewer_name AS leave_reviewed_by_name,
        COUNT(pa.id) FILTER (WHERE pa.punch_in IS NOT NULL AND pa.punch_out IS NOT NULL) AS completed_days,
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

        -- Holiday days: scoped by location and excluding configured week-offs
        COALESCE(holiday_agg.holiday_days, 0) AS holiday_days,

        -- Working days = total range days - week off days
        ($${endParam}::date - $${startParam}::date + 1) - COALESCE(weekoff_agg.week_off_count, 0) AS working_days

      FROM professional_employees pe
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      LEFT JOIN professional_attendance pa
        ON pa.professional_id = pe.id
       AND pa.date >= $${startParam}
       AND pa.date <= $${endParam}
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE plr.status = 'approved') AS leave_days,
          MAX(u.name) AS latest_reviewer_name
        FROM professional_leave_requests plr
        LEFT JOIN users u ON u.user_id = plr.reviewed_by
        WHERE plr.professional_id = pe.id
          AND plr.requested_date >= $${startParam}
          AND plr.requested_date <= $${endParam}
      ) leave_agg ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(gs.d) AS week_off_count
        FROM generate_series($${startParam}::date, $${endParam}::date, INTERVAL '1 day') AS gs(d)
        WHERE EXTRACT(DOW FROM gs.d)::int = ANY(
          SELECT UNNEST(pwo.week_off_days)
          FROM professional_week_off pwo
          WHERE pwo.professional_id = pe.id
          LIMIT 1
        )
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
          AND NOT EXISTS (
            SELECT 1
            FROM professional_week_off pwo2
            WHERE pwo2.professional_id = pe.id
              AND EXTRACT(DOW FROM h.holiday_date)::int = ANY(pwo2.week_off_days)
          )
      ) holiday_agg ON TRUE
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pe.ward_id = sec.sector_id
      LEFT JOIN wards w ON pe.ward_id = w.ward_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      WHERE 1=1 ${peFilters}
      GROUP BY pe.id, pe.full_name, pe.emp_code, pe.mobile, pe.email,
               COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name),
               COALESCE(wk_req.ward_name, wk.ward_name),
               z.zone_name, c.city_name,
               leave_agg.leave_days, leave_agg.latest_reviewer_name,
               weekoff_agg.week_off_count, holiday_agg.holiday_days
      ORDER BY (COUNT(pa.id) + COALESCE(leave_agg.leave_days, 0) + COALESCE(holiday_agg.holiday_days, 0)) DESC, pe.full_name ASC
      LIMIT $${startParam + 2} OFFSET $${startParam + 3}
    `;

    const countQuery = `
      ${cte}
      SELECT COUNT(*) AS total
      FROM professional_employees pe
      WHERE 1=1 ${peFilters}
    `;

    const finalParams = [...params, ...pageParams];
    const countParams = [...params];

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
        const totalRangeDays  = parseInt(row.total_range_days || 0, 10);
        const weekOffDays     = parseInt(row.week_off_days_count || 0, 10);
        const holidayDays     = parseInt(row.holiday_days || 0, 10);
        const workingDays     = parseInt(row.working_days || 0, 10);
        // Half day also counted as full for salary purposes (attendance_count = any punch-in)
        const effectivePresent = attendanceDays + leaveDays;
        const adjustedPresent  = effectivePresent + holidayDays;
        const absentDays       = Math.max(workingDays - adjustedPresent, 0);
        // Payable days include configured week off days as paid days.
        const payableDays      = Math.min(totalRangeDays, adjustedPresent + weekOffDays); // what HR uses for salary calculation

        return {
          ...row,
          attendance_count:        attendanceDays,
          leave_days:              leaveDays,
          leave_reviewed_by_name:  row.leave_reviewed_by_name || null,
          completed_days:          completedDays,
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
        pa.punch_in,
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
        leave_reviewer.name AS leave_reviewed_by_name,
        COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name) AS ward_name,
        COALESCE(wk_req.ward_name, wk.ward_name) as kothi_name,
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
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pe.ward_id = sec.sector_id
      LEFT JOIN wards w ON pe.ward_id = w.ward_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      ORDER BY cd.date DESC, pa.punch_in DESC NULLS LAST
    `;

    const detailsResult = await runQueryWithTimeout(detailsQuery, [
      professional_id,
      dateRange.startDate,
      dateRange.endDate
    ]);

    const mappedRows = await Promise.all(
      detailsResult.rows.map(async (row) => ({
        ...row,
        hours_worked: row.hours_worked == null ? '' : parseFloat(row.hours_worked).toFixed(2),
        punch_in_photo_url: row.punch_in_photo_url ? await getSignedS3Url(row.punch_in_photo_url, 900) : null,
        punch_out_photo_url: row.punch_out_photo_url ? await getSignedS3Url(row.punch_out_photo_url, 900) : null
      }))
    );

    const totalDays = mappedRows.length;
    const completedDays = mappedRows.filter((item) => item.hours_worked).length;
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
        completed_days: completedDays,
        leave_approved_days: leaveApprovedDays,
        leave_pending_days: leavePendingDays,
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
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, 'pe');
    
    let filters = `AND ${whereClause}`;
    const paramCount = params.length;

    const query = `
      ${cte}
      SELECT
        pe.id, pe.full_name as name, pe.emp_code, pe.mobile, pe.is_active, pe.face_locked, pe.created_at,
        COALESCE(sec.sector_name, w.ward_name) AS ward_name, z.zone_name, c.city_name,
        wk.ward_name as kothi_name
      FROM professional_employees pe
      LEFT JOIN sectors sec ON pe.ward_id = sec.sector_id
      LEFT JOIN wards w ON pe.ward_id = w.ward_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      JOIN zones z ON pe.zone_id = z.zone_id
      JOIN cities c ON pe.city_id = c.city_id
      WHERE 1=1 ${filters}
      ORDER BY pe.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    const countQuery = `
      ${cte}
      SELECT COUNT(*) as total FROM professional_employees pe WHERE 1=1 ${filters}
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

    // Fetch Attendance
    const query = `
      SELECT 
        date, punch_in, punch_out,
        CASE WHEN punch_out IS NULL AND date < CURRENT_DATE THEN NULL ELSE EXTRACT(EPOCH FROM (COALESCE(punch_out, NOW()) - punch_in)) / 3600 END AS hours_worked
      FROM professional_attendance
      WHERE professional_id = $1 
        AND EXTRACT(YEAR FROM date) = $2 
        AND EXTRACT(MONTH FROM date) = $3
      ORDER BY date DESC
    `;

    const attResult = await runQueryWithTimeout(query, [id, yyyy, mm]);

    res.json({
      success: true,
      data: attResult.rows.map(row => ({
        ...row,
        hours_worked: row.hours_worked == null ? '-' : parseFloat(row.hours_worked).toFixed(2),
        status: row.hours_worked == null ? 'absent' : (parseFloat(row.hours_worked) >= 4 ? 'present' : 'half-day')
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
