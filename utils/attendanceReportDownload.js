const SUPPORTED_FORMATS = new Set(["csv", "json"]);
const SUPPORTED_GROUPINGS = new Set([
  "detail",
  "zone",
  "ward",
  "city",
  "supervisor",
  "location",
]);

const csvEscapeValue = (value) => {
  if (value === null || value === undefined) {
    return '""';
  }
  const stringValue =
    value instanceof Date ? value.toISOString() : String(value);
  const escaped = stringValue.replace(/"/g, '""');
  return `"${escaped}"`;
};

const buildCsvDocument = (rows, headers) => {
  if (!headers?.length) {
    throw new Error("CSV headers are required");
  }

  const headerLine = headers
    .map((header) => csvEscapeValue(header.label || header.key))
    .join(",");

  if (!rows?.length) {
    return `${headerLine}\n`;
  }

  const dataLines = rows.map((row) =>
    headers
      .map((header) => {
        const rawValue =
          typeof header.formatter === "function"
            ? header.formatter(row[header.key], row)
            : row[header.key];
        return csvEscapeValue(rawValue ?? "");
      })
      .join(",")
  );

  return [headerLine, ...dataLines].join("\n");
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

const buildAttendanceFilters = (query, { locationExpression }) => {
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
  addNumericFilter(
    query.supervisor_id,
    (ph) => `supervisor.user_id = ${ph}`,
    "supervisor_id"
  );
  addNumericFilter(query.employee_id, (ph) => `a.emp_id = ${ph}`, "employee_id");

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
      TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out_time,
      a.duration,
      a.in_address,
      a.out_address,
      a.punch_in_image,
      a.punch_out_image,
      a.latitude_in,
      a.longitude_in,
      a.latitude_out,
      a.longitude_out,
      w.ward_id,
      w.ward_name,
      z.zone_id,
      z.zone_name,
      c.city_id,
      c.city_name,
      COALESCE(supervisor.user_id, 0) AS supervisor_id,
      COALESCE(supervisor.name, 'Unassigned') AS supervisor_name,
      COALESCE(u.name, 'Self') AS punched_in_by,
      COALESCE(u1.name, 'Self') AS punched_out_by
    `,
    orderBy: "a.date DESC, a.attendance_id DESC",
    csvHeaders: [
      { key: "sr_no", label: "Sr No." },
      { key: "attendance_id", label: "Attendance ID" },
      { key: "attendance_date", label: "Date" },
      { key: "employee_name", label: "Employee Name" },
      { key: "emp_code", label: "Employee Code" },
      { key: "contact_no", label: "Contact" },
      { key: "punch_in_time", label: "Punch In" },
      { key: "punch_out_time", label: "Punch Out" },
      { key: "duration", label: "Duration" },
      { key: "in_address", label: "In Address" },
      { key: "out_address", label: "Out Address" },
      { key: "ward_name", label: "Ward" },
      { key: "zone_name", label: "Zone" },
      { key: "city_name", label: "City" },
      { key: "supervisor_name", label: "Supervisor" },
      { key: "punched_in_by", label: "Punched In By" },
      { key: "punched_out_by", label: "Punched Out By" },
      { key: "punch_in_image", label: "Punch In Image" },
      { key: "punch_out_image", label: "Punch Out Image" },
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
      COUNT(*) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
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
      COUNT(*) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
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
      COUNT(*) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
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
      { key: "punch_out_count", label: "Punch Out Count" },
      { key: "first_attendance_date", label: "Earliest Date" },
      { key: "last_attendance_date", label: "Latest Date" },
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
      COUNT(*) AS total_records,
      COUNT(DISTINCT a.emp_id) AS employee_count,
      COUNT(a.punch_in_time) AS punch_in_count,
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
      { key: "punch_out_count", label: "Punch Out Count" },
      { key: "first_attendance_date", label: "Earliest Date" },
      { key: "last_attendance_date", label: "Latest Date" },
    ],
  },
};

const createAttendanceDownloadHandler =
  ({ pool, defaultFormat = "csv" } = {}) =>
  async (req, res) => {
    try {
      const format = (req.query.format || defaultFormat).toString().toLowerCase();

      if (!SUPPORTED_FORMATS.has(format)) {
        return res.status(400).json({
          error: `Unsupported format "${format}". Use one of: ${[
            ...SUPPORTED_FORMATS,
          ].join(", ")}`,
        });
      }

      const requestedGrouping = (req.query.group_by || "detail")
        .toString()
        .toLowerCase();
      if (!SUPPORTED_GROUPINGS.has(requestedGrouping)) {
        return res.status(400).json({
          error: `Invalid group_by "${req.query.group_by}". Supported values: ${[
            ...SUPPORTED_GROUPINGS,
          ].join(", ")}`,
        });
      }

      const groupConfig = groupingConfigs[requestedGrouping];
      const rawLocationType = (req.query.location_type || "both")
        .toString()
        .trim()
        .toLowerCase();
      const locationType = ["in", "out", "both"].includes(rawLocationType)
        ? rawLocationType
        : "both";
      const locationExpression = getLocationExpression(locationType);

      const { whereClause, params, metadata } = buildAttendanceFilters(
        req.query,
        {
          locationExpression,
        }
      );

      metadata.group_by = requestedGrouping;
      metadata.location_type = locationType;
      metadata.format = format;

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

      const downloadQuery = `
        SELECT
          ${selectClause}
        FROM attendance a
        JOIN employee e ON a.emp_id = e.emp_id
        JOIN wards w ON a.ward_id = w.ward_id
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
        LEFT JOIN supervisor_ward sw ON w.ward_id = sw.ward_id
        LEFT JOIN users supervisor ON sw.supervisor_id = supervisor.user_id
        LEFT JOIN users u ON a.punched_in_by = u.user_id
        LEFT JOIN users u1 ON a.punched_out_by = u1.user_id
        ${whereClause}
        ${groupByClause}
        ${orderByClause}
      `;

      const { rows } = await pool.query(downloadQuery, params);

      if (format === "json") {
        return res.json({
          group_by: requestedGrouping,
          location_type: locationType,
          filters: metadata,
          count: rows.length,
          data: rows,
        });
      }

      const headers =
        typeof groupConfig.csvHeaders === "function"
          ? groupConfig.csvHeaders({ locationExpression })
          : groupConfig.csvHeaders;
      const csvPayload = buildCsvDocument(rows, headers);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `attendance-${groupConfig.filenameSuffix}-report-${timestamp}.csv`;

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(csvPayload);
    } catch (error) {
      console.error("Error generating attendance download:", error);
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
