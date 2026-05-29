const SUPPORTED_FORMATS = new Set(["csv", "json"]);
const SUPPORTED_GROUPINGS = new Set([
  "detail",
  "zone",
  "ward",
  "city",
  "supervisor",
  "location",
  "ward_summary",
  "supervisor_summary",
]);

const ExcelJS = require('exceljs');

const buildExcelDocument = async (rows, headers, summaryRowData = null) => {
  if (!headers?.length) {
    throw new Error("Headers are required");
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Report");

  sheet.columns = headers.map(header => ({
    header: header.label || header.key,
    key: header.key,
    width: Math.max((header.label || header.key).length + 2, 10)
  }));

  if (rows?.length) {
    rows.forEach((row) => {
      const rowData = {};
      headers.forEach((header) => {
        let rawValue = typeof header.formatter === "function"
          ? header.formatter(row[header.key], row)
          : row[header.key];

        if (typeof rawValue === 'string') {
          if (rawValue.startsWith('="') && rawValue.endsWith('"')) {
            rawValue = rawValue.substring(2, rawValue.length - 1);
          } else if (rawValue.startsWith('=HYPERLINK("')) {
            const urlMatch = rawValue.match(/=HYPERLINK\("([^"]+)",\s*"([^"]+)"\)/);
            if (urlMatch) {
              rawValue = { text: urlMatch[2], hyperlink: urlMatch[1] };
            }
          }
        }
        rowData[header.key] = rawValue ?? "";
      });
      const addedRow = sheet.addRow(rowData);
      headers.forEach((header, idx) => {
        const cell = addedRow.getCell(idx + 1);
        if (cell.value && cell.value.hyperlink) {
          cell.font = { color: { argb: '0563C1' }, underline: true };
        }
      });
    });

    if (summaryRowData) {
      sheet.addRow([]); // Spacer row
      const summaryRow = sheet.addRow(summaryRowData);
      summaryRow.font = { bold: true };
      summaryRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF0F7FF' }
        };
        cell.border = {
          top: { style: 'thin' },
          bottom: { style: 'double' }
        };
      });
    }

    sheet.columns.forEach(column => {
      let maxLength = column.header ? column.header.length : 10;
      column.eachCell({ includeEmpty: false }, cell => {
        let cellLen = 0;
        if (cell.value && cell.value.text) cellLen = cell.value.text.length;
        else if (cell.value) cellLen = cell.value.toString().length;
        if (cellLen > maxLength) maxLength = cellLen;
      });
      column.width = Math.min(maxLength + 3, 50);
    });
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; // Slate 800
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };

  return await workbook.xlsx.writeBuffer();
};

const parseIntegerParam = (value) => {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "string" && value.trim().toLowerCase() === "all")
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseBooleanFlag = (value) => {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.toString().trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return null;
};

const getLocationExpression = (locationType = "both") => {
  switch (locationType) {
    case "in":
      return "COALESCE(NULLIF(TRIM(a.in_address), ''), 'Unknown Location')";
    case "out":
      return "COALESCE(NULLIF(TRIM(a.out_address), ''), 'Unknown Location')";
    default:
      return "COALESCE(NULLIF(TRIM(a.in_address), ''), NULLIF(TRIM(a.out_address), ''), 'Unknown Location')";
  }
};

const buildAttendanceFilters = (query, { locationExpression, cityScope, kothiScope }) => {
  const filters = [];
  const params = [];
  const metadata = {};

  const addTextFilter = (rawValue, builder, metaKey, { wildcard } = {}) => {
    const value = (rawValue ?? "").toString().trim();
    if (!value) {
      return;
    }
    const finalValue = wildcard ? `%${value}%` : value;
    params.push(finalValue);
    const placeholder = `$${params.length}`;
    filters.push(builder(placeholder));
    if (metaKey) {
      metadata[metaKey] = value;
    }
  };

  const addNumericFilter = (rawValue, builder, metaKey) => {
    const value = parseIntegerParam(rawValue);
    if (value === null) {
      return;
    }
    params.push(value);
    const placeholder = `$${params.length}`;
    filters.push(builder(placeholder));
    if (metaKey) {
      metadata[metaKey] = value;
    }
  };

  const date = (query.date || "").toString().trim();
  const startDate =
    (query.start_date ||
      query.date_from ||
      query.from_date ||
      query.from ||
      "").toString().trim();
  const endDate =
    (query.end_date ||
      query.date_to ||
      query.to_date ||
      query.to ||
      "").toString().trim();

  if (date) {
    addTextFilter(date, (ph) => `a.date = ${ph}`, "date");
  } else {
    if (startDate) {
      addTextFilter(startDate, (ph) => `a.date >= ${ph}`, "start_date");
    }
    if (endDate) {
      addTextFilter(endDate, (ph) => `a.date <= ${ph}`, "end_date");
    }
  }

  addNumericFilter(query.zone_id, (ph) => `z.zone_id = ${ph}`, "zone_id");
  addNumericFilter(query.ward_id, (ph) => `w.ward_id = ${ph}`, "ward_id");
  addNumericFilter(query.city_id, (ph) => `c.city_id = ${ph}`, "city_id");
  addNumericFilter(query.supervisor_id, (ph) => `supervisor.user_id = ${ph}`, "supervisor_id");
  addNumericFilter(query.employee_id, (ph) => `a.emp_id = ${ph}`, "employee_id");
  addNumericFilter(query.department_id, (ph) => `dept.department_id = ${ph}`, "department_id");
  addNumericFilter(query.designation_id, (ph) => `des.designation_id = ${ph}`, "designation_id");

  addTextFilter(query.emp_code, (ph) => `e.emp_code = ${ph}`, "emp_code");
  addTextFilter(
    query.zone_name,
    (ph) => `z.zone_name ILIKE ${ph}`,
    "zone_name",
    { wildcard: true }
  );
  addTextFilter(
    query.ward_name,
    (ph) => `w.ward_name ILIKE ${ph}`,
    "ward_name",
    { wildcard: true }
  );
  addTextFilter(
    query.city_name,
    (ph) => `c.city_name ILIKE ${ph}`,
    "city_name",
    { wildcard: true }
  );
  addTextFilter(
    query.supervisor_name,
    (ph) => `COALESCE(supervisor.name, '') ILIKE ${ph}`,
    "supervisor_name",
    { wildcard: true }
  );

  const searchTerm = (query.search || "").toString().trim();
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    const placeholder = `$${params.length}`;
    filters.push(
      `(e.name ILIKE ${placeholder} OR e.emp_code ILIKE ${placeholder})`
    );
    metadata.search = searchTerm;
  }

  const locationSearch = (query.location || "").toString().trim();
  if (locationSearch) {
    params.push(`%${locationSearch}%`);
    const placeholder = `$${params.length}`;
    filters.push(`(${locationExpression} ILIKE ${placeholder})`);
    metadata.location = locationSearch;
  }

  const hasPunchIn = parseBooleanFlag(query.has_punch_in);
  if (hasPunchIn !== null) {
    filters.push(
      hasPunchIn ? "a.punch_in_time IS NOT NULL" : "a.punch_in_time IS NULL"
    );
    metadata.has_punch_in = hasPunchIn;
  }

  const hasPunchOut = parseBooleanFlag(query.has_punch_out);
  if (hasPunchOut !== null) {
    filters.push(
      hasPunchOut ? "a.punch_out_time IS NOT NULL" : "a.punch_out_time IS NULL"
    );
    metadata.has_punch_out = hasPunchOut;
  }

  const shift = (query.shift || "").toString().toLowerCase().trim();
  if (shift && shift !== "all") {
    if (shift === "morning") {
      filters.push("a.punch_in_time::time >= '06:00:00' AND a.punch_in_time::time < '13:59:59'");
    } else if (shift === "afternoon") {
      filters.push("a.punch_in_time::time >= '14:00:00' AND a.punch_in_time::time < '21:59:59'");
    } else if (shift === "night") {
      filters.push("(a.punch_in_time::time >= '22:00:00' OR a.punch_in_time::time < '05:59:59')");
    }
    metadata.shift = shift;
  }

  if (cityScope && !cityScope.all) {
    if (!cityScope.ids || cityScope.ids.length === 0) {
      filters.push("1 = 0");
    } else {
      params.push(cityScope.ids);
      const placeholder = `$${params.length}`;
      filters.push(`c.city_id = ANY(${placeholder})`);
      metadata.city_scope = cityScope.ids;
    }
  }

  if (kothiScope && !kothiScope.all) {
    if (!kothiScope.ids || kothiScope.ids.length === 0) {
      filters.push("1 = 0");
    } else {
      params.push(kothiScope.ids);
      const placeholder = `$${params.length}`;
      filters.push(`w.ward_id = ANY(${placeholder})`);
      metadata.kothi_scope = kothiScope.ids;
    }
  }

  return {
    whereClause: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params,
    metadata,
  };
};

const buildSupervisorSummaryFilters = (query, { cityScope, kothiScope }) => {
  const filters = [];
  const params = [];
  const metadata = {};

  const addNumericFilter = (rawValue, builder, metaKey) => {
    const value = parseIntegerParam(rawValue);
    if (value === null) {
      return;
    }
    params.push(value);
    const placeholder = `$${params.length}`;
    filters.push(builder(placeholder));
    if (metaKey) {
      metadata[metaKey] = value;
    }
  };

  const addTextFilter = (rawValue, builder, metaKey) => {
    const value = (rawValue ?? "").toString().trim();
    if (!value) {
      return;
    }
    params.push(value);
    const placeholder = `$${params.length}`;
    filters.push(builder(placeholder));
    if (metaKey) {
      metadata[metaKey] = value;
    }
  };

  addNumericFilter(query.city_id, (ph) => `c.city_id = ${ph}`, "city_id");
  addNumericFilter(query.zone_id, (ph) => `z.zone_id = ${ph}`, "zone_id");
  addNumericFilter(query.ward_id, (ph) => `w.ward_id = ${ph}`, "ward_id");
  addNumericFilter(
    query.supervisor_id,
    (ph) => `supervisor.user_id = ${ph}`,
    "supervisor_id"
  );
  addTextFilter(
    query.supervisor_name,
    (ph) => `COALESCE(supervisor.name, '') ILIKE ${ph}`,
    "supervisor_name"
  );

  if (cityScope && !cityScope.all) {
    if (!cityScope.ids || cityScope.ids.length === 0) {
      filters.push("1 = 0");
    } else {
      params.push(cityScope.ids);
      const placeholder = `$${params.length}`;
      filters.push(`c.city_id = ANY(${placeholder})`);
      metadata.city_scope = cityScope.ids;
    }
  }

  if (kothiScope && !kothiScope.all) {
    if (!kothiScope.ids || kothiScope.ids.length === 0) {
      filters.push("1 = 0");
    } else {
      params.push(kothiScope.ids);
      const placeholder = `$${params.length}`;
      filters.push(`w.ward_id = ANY(${placeholder})`);
      metadata.kothi_scope = kothiScope.ids;
    }
  }

  return {
    whereClause: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
    params,
    metadata,
  };
};

const groupingConfigs = {
  detail: {
    label: "Detailed",
    filenameSuffix: "detailed",
    select: () => `
      ROW_NUMBER() OVER (ORDER BY a.date DESC, a.attendance_id DESC) AS sr_no,
      a.attendance_id,
      e.emp_id AS emp_id,
      e.name AS employee_name,
      e.emp_code,
      e.phone AS contact_no,
      TO_CHAR(a.date, 'DD-MM-YYYY') AS attendance_date,
      TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in_time,
      TO_CHAR(a.mid_shift_punch_in_time, 'HH24:MI:SS') AS mid_shift_punch_in_time,
      TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out_time,
      a.leave_type,
      a.duration,
      a.in_address,
      a.out_address,
      a.latitude_in,
      a.longitude_in,
      a.latitude_out,
      a.longitude_out,
      a.mid_in_address,
      a.latitude_mid_in,
      a.longitude_mid_in,
      w.ward_id,
      w.ward_name,
      z.zone_id,
      z.zone_name,
      c.city_name,
      dept.department_name,
      des.designation_name,
      0 AS supervisor_id,
      COALESCE(supervisor_agg.supervisor_names, 'Unassigned') AS supervisor_name,
      COALESCE(u.name, '-') AS punched_in_by,
      COALESCE(u2.name, '-') AS mid_shift_punched_in_by,
      CASE 
        WHEN a.is_auto_punch_out = true THEN 'System (Auto)'
        ELSE COALESCE(u1.name, '-')
      END AS punched_out_by
    `,
    orderBy: "a.date DESC, a.attendance_id DESC",
    csvHeaders: [
      { key: "sr_no", label: "Sr No." },
      { key: "attendance_date", label: "Date" },
      { key: "zone_name", label: "Zone", formatter: (val) => val || "-" },
      { key: "ward_name", label: "Ward", formatter: (val) => val || "-" },
      { key: "employee_name", label: "Employee Name", formatter: (val) => val || "-" },
      { key: "leave_type", label: "Leave Type", formatter: (val) => val || "-" },
      { key: "emp_code", label: "Emp Code", formatter: (val) => val ? `="${val}"` : "-" },
      { key: "contact_no", label: "Contact No.", formatter: (val) => val ? `="${val}"` : "-" },
      { key: "punch_in_time", label: "Punch In Time", formatter: (val) => val || "-" },
      { key: "punched_in_by", label: "Punched In By", formatter: (val, row) => row.punch_in_time ? val : "-" },
      { key: "mid_shift_punch_in_time", label: "Mid Shift Punch In", formatter: (val) => val || "-" },
      { key: "mid_shift_punched_in_by", label: "Mid Shift Punched By", formatter: (val, row) => row.mid_shift_punch_in_time ? val : "-" },
      { key: "mid_in_address", label: "Mid In Address", formatter: (val) => val || "-" },
      { key: "latitude_mid_in", label: "Mid In Lat / Long", formatter: (_, row) => (row.latitude_mid_in && row.longitude_mid_in) ? `=HYPERLINK("https://www.google.com/maps?q=${row.latitude_mid_in},${row.longitude_mid_in}", "${Number(row.latitude_mid_in).toFixed(6)}, ${Number(row.longitude_mid_in).toFixed(6)}")` : "-" },
      { key: "in_address", label: "In Address", formatter: (val) => val || "-" },
      { key: "latitude_in", label: "In Lat / Long", formatter: (_, row) => (row.latitude_in && row.longitude_in) ? `=HYPERLINK("https://www.google.com/maps?q=${row.latitude_in},${row.longitude_in}", "${Number(row.latitude_in).toFixed(6)}, ${Number(row.longitude_in).toFixed(6)}")` : "-" },
      { key: "punch_out_time", label: "Punch Out Time", formatter: (val) => val || "-" },
      { key: "punched_out_by", label: "Punched Out By", formatter: (val, row) => row.punch_out_time ? val : "-" },
      { key: "out_address", label: "Out Address", formatter: (val) => val || "-" },
      { key: "latitude_out", label: "Out Lat / Long", formatter: (_, row) => (row.latitude_out && row.longitude_out) ? `=HYPERLINK("https://www.google.com/maps?q=${row.latitude_out},${row.longitude_out}", "${Number(row.latitude_out).toFixed(6)}, ${Number(row.longitude_out).toFixed(6)}")` : "-" },
    ],
  },
  zone: {
    label: "Zone",
    filenameSuffix: "zone",
    select: () => `
      z.zone_id,
      z.zone_name,
      c.city_id,
      c.city_name,
      COUNT(DISTINCT a.attendance_id) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
      COUNT(a.mid_shift_punch_in_time) AS mid_shift_punch_in_count,
      COUNT(a.punch_out_time) AS punch_out_count,
      TO_CHAR(MIN(a.date), 'DD-MM-YYYY') AS first_attendance_date,
      TO_CHAR(MAX(a.date), 'DD-MM-YYYY') AS last_attendance_date,
      TO_CHAR(MIN(a.punch_in_time), 'DD-MM-YYYY HH24:MI:SS') AS first_punch_in_time,
      TO_CHAR(MAX(a.punch_out_time), 'DD-MM-YYYY HH24:MI:SS') AS last_punch_out_time
    `,
    groupBy: "z.zone_id, z.zone_name, c.city_id, c.city_name",
    orderBy: "c.city_name, z.zone_name",
    csvHeaders: [
      { key: "zone_id", label: "Zone ID" },
      { key: "zone_name", label: "Zone" },
      { key: "city_id", label: "City ID" },
      { key: "city_name", label: "City" },
      { key: "total_records", label: "Attendance Rows" },
      { key: "employee_count", label: "Unique Employees" },
      { key: "punch_in_count", label: "Punch In Count" },
      { key: "mid_shift_punch_in_count", label: "Mid Shift Punch In Count" },
      { key: "punch_out_count", label: "Punch Out Count" },
      { key: "first_attendance_date", label: "Earliest Date" },
      { key: "last_attendance_date", label: "Latest Date" },
      { key: "first_punch_in_time", label: "First Punch In" },
      { key: "last_punch_out_time", label: "Last Punch Out" },
    ],
  },
  ward: {
    label: "Ward",
    filenameSuffix: "ward",
    select: () => `
      w.ward_id,
      w.ward_name,
      z.zone_id,
      z.zone_name,
      c.city_id,
      c.city_name,
      COALESCE(array_to_string(array_agg(DISTINCT COALESCE(supervisor.name, 'Unassigned')), ', '), 'Unassigned') AS supervisors,
      COUNT(DISTINCT a.attendance_id) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
      COUNT(a.mid_shift_punch_in_time) AS mid_shift_punch_in_count,
      COUNT(a.punch_out_time) AS punch_out_count,
      TO_CHAR(MIN(a.date), 'DD-MM-YYYY') AS first_attendance_date,
      TO_CHAR(MAX(a.date), 'DD-MM-YYYY') AS last_attendance_date
    `,
    groupBy:
      "w.ward_id, w.ward_name, z.zone_id, z.zone_name, c.city_id, c.city_name",
    orderBy: "c.city_name, z.zone_name, w.ward_name",
    csvHeaders: [
      { key: "ward_id", label: "Ward ID" },
      { key: "ward_name", label: "Ward" },
      { key: "zone_id", label: "Zone ID" },
      { key: "zone_name", label: "Zone" },
      { key: "city_id", label: "City ID" },
      { key: "city_name", label: "City" },
      { key: "supervisors", label: "Supervisors" },
      { key: "total_records", label: "Attendance Rows" },
      { key: "employee_count", label: "Unique Employees" },
      { key: "punch_in_count", label: "Punch In Count" },
      { key: "mid_shift_punch_in_count", label: "Mid Shift Punch In Count" },
      { key: "punch_out_count", label: "Punch Out Count" },
      { key: "first_attendance_date", label: "Earliest Date" },
      { key: "last_attendance_date", label: "Latest Date" },
    ],
  },
  city: {
    label: "City",
    filenameSuffix: "city",
    select: () => `
      c.city_id,
      c.city_name,
      COALESCE(array_to_string(array_agg(DISTINCT z.zone_name), ', '), 'N/A') AS zones,
      COUNT(DISTINCT a.attendance_id) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
      COUNT(a.mid_shift_punch_in_time) AS mid_shift_punch_in_count,
      COUNT(a.punch_out_time) AS punch_out_count,
      TO_CHAR(MIN(a.date), 'DD-MM-YYYY') AS first_attendance_date,
      TO_CHAR(MAX(a.date), 'DD-MM-YYYY') AS last_attendance_date
    `,
    groupBy: "c.city_id, c.city_name",
    orderBy: "c.city_name",
    csvHeaders: [
      { key: "city_id", label: "City ID" },
      { key: "city_name", label: "City" },
      { key: "zones", label: "Zones" },
      { key: "total_records", label: "Attendance Rows" },
      { key: "employee_count", label: "Unique Employees" },
      { key: "punch_in_count", label: "Punch In Count" },
      { key: "mid_shift_punch_in_count", label: "Mid Shift Punch In Count" },
      { key: "punch_out_count", label: "Punch Out Count" },
      { key: "first_attendance_date", label: "Earliest Date" },
      { key: "last_attendance_date", label: "Latest Date" },
    ],
  },
  supervisor: {
    label: "Supervisor",
    filenameSuffix: "supervisor",
    select: () => `
      COALESCE(supervisor.user_id, 0) AS supervisor_id,
      COALESCE(supervisor.name, 'Unassigned') AS supervisor_name,
      COALESCE(supervisor.emp_code, 'N/A') AS supervisor_emp_code,
      COALESCE(array_to_string(array_agg(DISTINCT w.ward_name), ', '), 'N/A') AS wards_covered,
      COALESCE(array_to_string(array_agg(DISTINCT z.zone_name), ', '), 'N/A') AS zones_covered,
      COALESCE(array_to_string(array_agg(DISTINCT c.city_name), ', '), 'N/A') AS cities_covered,
      COUNT(*) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
      COUNT(a.mid_shift_punch_in_time) AS mid_shift_punch_in_count,
      COUNT(a.punch_out_time) AS punch_out_count,
      TO_CHAR(MIN(a.date), 'DD-MM-YYYY') AS first_attendance_date,
      TO_CHAR(MAX(a.date), 'DD-MM-YYYY') AS last_attendance_date
    `,
    groupBy:
      "COALESCE(supervisor.user_id, 0), COALESCE(supervisor.name, 'Unassigned'), COALESCE(supervisor.emp_code, 'N/A')",
    orderBy: "supervisor_name",
    csvHeaders: [
      { key: "supervisor_id", label: "Supervisor ID" },
      { key: "supervisor_emp_code", label: "Supervisor Code" },
      { key: "supervisor_name", label: "Supervisor" },
      { key: "wards_covered", label: "Wards" },
      { key: "zones_covered", label: "Zones" },
      { key: "cities_covered", label: "Cities" },
      { key: "total_records", label: "Attendance Rows" },
      { key: "employee_count", label: "Unique Employees" },
      { key: "punch_in_count", label: "Punch In Count" },
      { key: "mid_shift_punch_in_count", label: "Mid Shift Punch In Count" },
      { key: "punch_out_count", label: "Punch Out Count" },
      { key: "first_attendance_date", label: "Earliest Date" },
      { key: "last_attendance_date", label: "Latest Date" },
    ],
  },
  supervisor_summary: {
    label: "Supervisor Summary",
    filenameSuffix: "supervisor-summary",
    select: () => `
      COALESCE(supervisor.user_id, 0) AS supervisor_id,
      COALESCE(supervisor.name, 'Unassigned') AS supervisor_name,
      COALESCE(supervisor.emp_code, 'N/A') AS supervisor_emp_code,
      COALESCE(supervisor.phone, 'N/A') AS supervisor_contact,
      COUNT(DISTINCT emp_all.emp_id) AS total_employees,
      COUNT(DISTINCT CASE WHEN a_yesterday.punch_in_time IS NOT NULL THEN a_yesterday.emp_id END) AS present_yesterday,
      COUNT(DISTINCT emp_all.emp_id) - COUNT(DISTINCT CASE WHEN a_yesterday.punch_in_time IS NOT NULL THEN a_yesterday.emp_id END) AS absentees_yesterday
    `,
    groupBy: `
      COALESCE(supervisor.user_id, 0),
      COALESCE(supervisor.name, 'Unassigned'),
      COALESCE(supervisor.emp_code, 'N/A'),
      COALESCE(supervisor.phone, 'N/A')
    `,
    orderBy: "supervisor_name",
    fromOverride: `
      FROM wards w
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
    `,
    joinOverride: `
      LEFT JOIN supervisor_ward sw ON w.ward_id = sw.ward_id
      LEFT JOIN users supervisor ON sw.supervisor_id = supervisor.user_id
      LEFT JOIN LATERAL (
        SELECT DISTINCT emp.emp_id
        FROM employee emp
        WHERE emp.ward_id = w.ward_id
      ) emp_all ON true
      LEFT JOIN attendance a_yesterday ON a_yesterday.emp_id = emp_all.emp_id
        AND a_yesterday.date = (CURRENT_DATE - INTERVAL '1 day')
    `,
    havingClauseBuilder: ({ query }) =>
      parseBooleanFlag(query.absentees_only)
        ? "HAVING COUNT(DISTINCT emp_all.emp_id) - COUNT(DISTINCT CASE WHEN a_yesterday.punch_in_time IS NOT NULL THEN a_yesterday.emp_id END) > 0"
        : "",
    csvHeaders: [
      { key: "supervisor_id", label: "Supervisor ID" },
      { key: "supervisor_emp_code", label: "Supervisor Code" },
      { key: "supervisor_name", label: "Supervisor Name" },
      { key: "supervisor_contact", label: "Supervisor Contact" },
      { key: "total_employees", label: "Total Employees" },
      { key: "present_yesterday", label: "Present Yesterday" },
      { key: "absentees_yesterday", label: "Absent Yesterday" },
    ],
  },
  location: {
    label: "Location",
    filenameSuffix: "location",
    select: ({ locationExpression }) => `
      ${locationExpression} AS location_label,
      COALESCE(array_to_string(array_agg(DISTINCT w.ward_name), ', '), 'N/A') AS wards,
      COALESCE(array_to_string(array_agg(DISTINCT z.zone_name), ', '), 'N/A') AS zones,
      COALESCE(array_to_string(array_agg(DISTINCT c.city_name), ', '), 'N/A') AS cities,
      COUNT(DISTINCT a.attendance_id) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
      COUNT(a.mid_shift_punch_in_time) AS mid_shift_punch_in_count,
      COUNT(a.punch_out_time) AS punch_out_count,
      TO_CHAR(MIN(a.date), 'DD-MM-YYYY') AS first_attendance_date,
      TO_CHAR(MAX(a.date), 'DD-MM-YYYY') AS last_attendance_date
    `,
    groupBy: ({ locationExpression }) => locationExpression,
    orderBy: "location_label",
    csvHeaders: [
      { key: "location_label", label: "Location" },
      { key: "wards", label: "Ward(s)" },
      { key: "zones", label: "Zone(s)" },
      { key: "cities", label: "City(s)" },
      { key: "total_records", label: "Attendance Rows" },
      { key: "employee_count", label: "Unique Employees" },
      { key: "punch_in_count", label: "Punch In Count" },
      { key: "mid_shift_punch_in_count", label: "Mid Shift Punch In Count" },
      { key: "punch_out_count", label: "Punch Out Count" },
      { key: "first_attendance_date", label: "Earliest Date" },
      { key: "last_attendance_date", label: "Latest Date" },
    ],
  },
  ward_summary: {
    label: "Ward Summary",
    filenameSuffix: "ward-summary",
    select: () => `
      c.city_name AS city_name,
      z.zone_name AS zone_name,
      w.ward_name AS kothi_name,
      COALESCE(supervisor_agg.supervisor_names, 'Unassigned') AS supervisor_name,
      (SELECT COUNT(*) FROM employee reg WHERE reg.ward_id = w.ward_id) AS total_registered,
      COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL THEN a.emp_id END) AS total_present
    `,
    groupBy: `c.city_name, z.zone_name, w.ward_name, supervisor_agg.supervisor_names`,
    orderBy: "c.city_name, z.zone_name, w.ward_name",
    csvHeaders: [
      { key: "city_name", label: "City" },
      { key: "zone_name", label: "Zone" },
      { key: "kothi_name", label: "Kothi Name" },
      { key: "supervisor_name", label: "Supervisor Name" },
      { key: "total_registered", label: "Total Registered" },
      { key: "total_present", label: "Total Present" },
    ],
  },
};

const createAttendanceDownloadHandler =
  ({ pool, defaultFormat = "csv", resolveCityScope, resolveKothiScope } = {}) =>
    async (req, res) => {
      let payload = null;
      try {
        payload = { ...req.query, ...req.body };
        const format = (payload.format || defaultFormat).toString().toLowerCase();

        if (!SUPPORTED_FORMATS.has(format)) {
          return res.status(400).json({
            error: `Unsupported format "${format}". Use one of: ${[
              ...SUPPORTED_FORMATS,
            ].join(", ")}`,
          });
        }

        const requestedGrouping = (payload.group_by || "detail")
          .toString()
          .toLowerCase();
        if (!SUPPORTED_GROUPINGS.has(requestedGrouping)) {
          return res.status(400).json({
            error: `Invalid group_by "${payload.group_by}". Supported values: ${[
              ...SUPPORTED_GROUPINGS,
            ].join(", ")}`,
          });
        }

        const groupConfig = groupingConfigs[requestedGrouping];
        const rawLocationType = (payload.location_type || "both")
          .toString()
          .trim()
          .toLowerCase();
        const locationType = ["in", "out", "both"].includes(rawLocationType)
          ? rawLocationType
          : "both";
        const locationExpression = getLocationExpression(locationType);
        const cityScope = resolveCityScope?.(req) || { all: false, ids: [] };
        const kothiScope = resolveKothiScope?.(req) || { all: true, ids: [] };
        const requestedCityId = parseIntegerParam(payload.city_id);

        if (!cityScope.all) {
          const allowedIds = (cityScope.ids || []).map((id) => Number(id));
          if (!allowedIds.length) {
            return res
              .status(403)
              .json({ error: "No city access assigned. Please contact admin." });
          }
          if (
            requestedCityId !== null &&
            !allowedIds.includes(Number(requestedCityId))
          ) {
            return res.status(403).json({
              error: "Forbidden: city not assigned to the current user.",
            });
          }
        }

        const filterResult =
          requestedGrouping === "supervisor_summary"
            ? buildSupervisorSummaryFilters(payload, {
              cityScope,
              kothiScope,
            })
            : buildAttendanceFilters(payload, {
              locationExpression,
              cityScope,
              kothiScope,
            });

        const { whereClause, params, metadata } = filterResult;

        metadata.group_by = requestedGrouping;
        metadata.location_type = locationType;
        metadata.format = format;
        const absOnlyFlag = parseBooleanFlag(payload.absentees_only);
        if (absOnlyFlag !== null) {
          metadata.absentees_only = absOnlyFlag;
        }

        let allRows;

        if (requestedGrouping === "detail") {
          // Single unified query: start from employee and left-join attendance for the target date.
          const targetDate =
            payload.date ||
            payload.start_date ||
            payload.date_from ||
            new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

          const detailParams = [targetDate];
          const filters = [];
          const hasPunchInFlag = parseBooleanFlag(payload.has_punch_in);
          const hasPunchOutFlag = parseBooleanFlag(payload.has_punch_out);
          const absOnlyFlag = parseBooleanFlag(payload.absentees_only);

          // City scope
          if (!cityScope.all) {
            detailParams.push(cityScope.ids);
            filters.push(`c.city_id = ANY($${detailParams.length}::int[])`);
          } else if (requestedCityId !== null) {
            detailParams.push(requestedCityId);
            filters.push(`c.city_id = $${detailParams.length}`);
          }

          // Kothi scope
          if (!kothiScope.all) {
            detailParams.push(kothiScope.ids);
            filters.push(`w.ward_id = ANY($${detailParams.length}::int[])`);
          }

          // Optional filters
          const zoneId = parseIntegerParam(payload.zone_id);
          if (zoneId !== null) {
            detailParams.push(zoneId);
            filters.push(`z.zone_id = $${detailParams.length}`);
          }
          const wardId = parseIntegerParam(payload.ward_id || payload.kothi_id);
          if (wardId !== null) {
            detailParams.push(wardId);
            filters.push(`w.ward_id = $${detailParams.length}`);
          }
          const supervisorId = parseIntegerParam(payload.supervisor_id);
          if (supervisorId !== null) {
            detailParams.push(supervisorId);
            filters.push(
              `EXISTS (SELECT 1 FROM supervisor_ward sw2 WHERE sw2.ward_id = w.ward_id AND sw2.supervisor_id = $${detailParams.length})`
            );
          }
          const employeeId = parseIntegerParam(payload.employee_id);
          if (employeeId !== null) {
            detailParams.push(employeeId);
            filters.push(`e.emp_id = $${detailParams.length}`);
          }
          const empCode = (payload.emp_code || "").toString().trim();
          if (empCode) {
            detailParams.push(empCode);
            filters.push(`e.emp_code = $${detailParams.length}`);
          }
          const departmentId = parseIntegerParam(payload.department_id);
          if (departmentId !== null) {
            detailParams.push(departmentId);
            filters.push(`dept.department_id = $${detailParams.length}`);
          }
          const designationId = parseIntegerParam(payload.designation_id);
          if (designationId !== null) {
            detailParams.push(designationId);
            filters.push(`des.designation_id = $${detailParams.length}`);
          }
          if (absOnlyFlag === true) {
            filters.push("a.punch_in_time IS NULL");
          }
          if (hasPunchInFlag !== null) {
            filters.push(
              hasPunchInFlag
                ? "a.punch_in_time IS NOT NULL"
                : "a.punch_in_time IS NULL"
            );
          }
          if (hasPunchOutFlag !== null) {
            filters.push(
              hasPunchOutFlag
                ? "a.punch_out_time IS NOT NULL"
                : "a.punch_out_time IS NULL"
            );
          }

          const whereCombined = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

          const unifiedQuery = `
            SELECT
              ROW_NUMBER() OVER (ORDER BY a.attendance_id DESC NULLS LAST, e.name ASC) AS sr_no,
              a.attendance_id,
              e.emp_id AS emp_id,
              e.name AS employee_name,
              e.emp_code,
              e.phone AS contact_no,
              TO_CHAR($1::date, 'DD-MM-YYYY') AS attendance_date,
              TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in_time,
              TO_CHAR(a.mid_shift_punch_in_time, 'HH24:MI:SS') AS mid_shift_punch_in_time,
              TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out_time,
              a.leave_type,
              a.duration,
              a.in_address,
              a.latitude_in,
              a.longitude_in,
              a.out_address,
              a.latitude_out,
              a.longitude_out,
              a.mid_in_address,
              a.latitude_mid_in,
              a.longitude_mid_in,
              w.ward_id,
              w.ward_name,
              z.zone_id,
              z.zone_name,
              c.city_id,
              c.city_name,
              dept.department_name,
              des.designation_name,
              0 AS supervisor_id,
              COALESCE(supervisor_agg.supervisor_names, 'Unassigned') AS supervisor_name,
              COALESCE(u.name, 'Self') AS punched_in_by,
              COALESCE(u2.name, 'Self') AS mid_shift_punched_in_by,
              COALESCE(u1.name, 'Self') AS punched_out_by
            FROM employee e
            JOIN wards w ON e.ward_id = w.ward_id
            JOIN zones z ON w.zone_id = z.zone_id
            JOIN cities c ON z.city_id = c.city_id
            LEFT JOIN (
              SELECT sw_agg.ward_id, STRING_AGG(su_agg.name, ', ' ORDER BY su_agg.name) AS supervisor_names
              FROM supervisor_ward sw_agg
              JOIN users su_agg ON sw_agg.supervisor_id = su_agg.user_id
              GROUP BY sw_agg.ward_id
            ) supervisor_agg ON w.ward_id = supervisor_agg.ward_id
            LEFT JOIN designation des ON e.designation_id = des.designation_id
            LEFT JOIN department dept ON des.department_id = dept.department_id
            -- Removed direct supervisor join to prevent row duplication.
            -- Using correlate subquery instead for supervisor_name.
            LEFT JOIN LATERAL (
              SELECT 
                att.attendance_id, 
                att.punch_in_time, 
                att.mid_shift_punch_in_time,
                att.punch_out_time, 
                att.leave_type,
                att.duration, 
                att.in_address,
                att.latitude_in,
                att.longitude_in,
                att.out_address,
                att.latitude_out,
                att.longitude_out,
                att.mid_in_address,
                att.latitude_mid_in,
                att.longitude_mid_in,
                att.punched_in_by,
                att.mid_shift_punched_in_by,
                att.punched_out_by
              FROM attendance att
              WHERE att.emp_id = e.emp_id 
                AND (att.date = $1::date OR att.date = $1)
              ORDER BY att.attendance_id DESC
              LIMIT 1
            ) a ON TRUE
            LEFT JOIN users u ON a.punched_in_by = u.user_id
            LEFT JOIN users u2 ON a.mid_shift_punched_in_by = u2.user_id
            LEFT JOIN users u1 ON a.punched_out_by = u1.user_id
            ${whereCombined}
            ORDER BY a.attendance_id DESC NULLS LAST, e.name ASC;
          `;

          const unifiedResult = await pool.query(unifiedQuery, detailParams);
          allRows = unifiedResult.rows;
        } else {
          const selectClause =
            typeof groupConfig.select === "function"
              ? groupConfig.select({ locationExpression })
              : groupConfig.select;
          const groupByClauseRaw =
            typeof groupConfig.groupBy === "function"
              ? groupConfig.groupBy({ locationExpression })
              : groupConfig.groupBy;
          const orderByClauseRaw =
            typeof groupConfig.orderBy === "function"
              ? groupConfig.orderBy({ locationExpression })
              : groupConfig.orderBy;

          const groupByClause = groupByClauseRaw
            ? `GROUP BY ${groupByClauseRaw}`
            : "";
          const orderByClause = orderByClauseRaw
            ? `ORDER BY ${orderByClauseRaw}`
            : "";

          const defaultFromClause = `
        FROM attendance a
        JOIN employee e ON a.emp_id = e.emp_id
        JOIN wards w ON a.ward_id = w.ward_id
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
      `;

          const defaultJoinClause = `
        LEFT JOIN (
          SELECT sw_agg.ward_id, STRING_AGG(su_agg.name, ', ' ORDER BY su_agg.name) AS supervisor_names
          FROM supervisor_ward sw_agg
          JOIN users su_agg ON sw_agg.supervisor_id = su_agg.user_id
          GROUP BY sw_agg.ward_id
        ) supervisor_agg ON w.ward_id = supervisor_agg.ward_id
        LEFT JOIN users u ON a.punched_in_by = u.user_id
        LEFT JOIN users u2 ON a.mid_shift_punched_in_by = u2.user_id
        LEFT JOIN users u1 ON a.punched_out_by = u1.user_id
      `;

          const fromClause =
            typeof groupConfig.fromOverride === "string"
              ? groupConfig.fromOverride
              : defaultFromClause;

          const joinClause =
            typeof groupConfig.joinOverride === "string"
              ? groupConfig.joinOverride
              : groupConfig.fromOverride
                ? ""
                : defaultJoinClause;

          const havingClause =
            typeof groupConfig.havingClauseBuilder === "function"
              ? groupConfig.havingClauseBuilder({
                query: payload,
              })
              : "";

          const downloadQuery = `
      SELECT
        ${selectClause}
        ${fromClause}
      ${joinClause}
      ${whereClause}
      ${groupByClause}
      ${havingClause}
      ${orderByClause}
    `;

          const { rows } = await pool.query(downloadQuery, params);
          allRows = rows;
        }
        if (allRows && allRows.length) {
          allRows.forEach((row, idx) => {
            row.sr_no = idx + 1;
          });
        }

        if (format === "json") {
          return res.json({
            group_by: requestedGrouping,
            location_type: locationType,
            filters: metadata,
            count: allRows.length,
            data: allRows,
          });
        }

        const headers =
          typeof groupConfig.csvHeaders === "function"
            ? groupConfig.csvHeaders({ locationExpression })
            : groupConfig.csvHeaders;

        let summaryRowData = null;
        if (requestedGrouping === "detail" && allRows.length > 0) {
          const totalRecords = allRows.length;
          const presentCount = allRows.filter(r => r.punch_in_time && r.punch_in_time !== '-').length;
          
          summaryRowData = {};
          headers.forEach(h => {
            if (h.key === "sr_no") summaryRowData[h.key] = "TOTAL";
            else if (h.key === "employee_name") summaryRowData[h.key] = `Records: ${totalRecords}`;
            else if (h.key === "punch_in_time") summaryRowData[h.key] = `Present: ${presentCount}`;
            else summaryRowData[h.key] = "";
          });
        }

        const excelBuffer = await buildExcelDocument(allRows, headers, summaryRowData);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `attendance-${groupConfig.filenameSuffix}-report-${timestamp}.xlsx`;

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(excelBuffer);
      } catch (error) {
        // Note: payload may be undefined if parsing failed earlier, so guard it.
        console.error("Error generating attendance download:", {
          message: error?.message,
          stack: error?.stack,
          payload: payload || req.body || req.query,
          user: req.user,
        });
        return res.status(500).json({
          error: "Unable to generate filtered attendance report",
          details: error?.message || "Unknown error",
        });
      }
    };

module.exports = {
  createAttendanceDownloadHandler,
  SUPPORTED_FORMATS,
  SUPPORTED_GROUPINGS,
};
