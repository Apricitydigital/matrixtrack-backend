// Group the complete scoped month before paging employees. The daily API remains unchanged.
function employeeSummaryQuery(ctes, params) {
  const sources = ctes.map((cte, i) => `source_${i} AS (${cte} SELECT to_jsonb(r) AS row FROM records r)`);
  return { params, sql: `WITH ${sources.join(',')},
    combined AS (${ctes.map((_, i) => `SELECT row FROM source_${i}`).join(' UNION ALL ')}),
    employees AS (
      SELECT row->>'employee_kind' AS employee_kind,row->>'employee_id' AS employee_id,
        MAX(row->>'full_name') AS full_name,MAX(row->>'emp_code') AS emp_code,
        MAX(row->>'site_name') AS site_name,
        BOOL_OR(COALESCE((row->>'is_attendance_blocked')::boolean,FALSE)) AS is_attendance_blocked,
        COUNT(DISTINCT row->>'date') FILTER (WHERE row->>'date'<=$6::text
          AND row->>'status' NOT IN ('weekly-off','holiday','upcoming'))::int AS working_days,
        COUNT(DISTINCT row->>'date') FILTER (WHERE row->>'date'<=$6::text
          AND row->>'status' IN ('present','half-day'))::int AS attended_days,
        COUNT(DISTINCT row->>'date') FILTER (WHERE row->>'date'<=$6::text AND row->>'status'='half-day')::int AS half_days,
        COUNT(DISTINCT row->>'date') FILTER (WHERE row->>'date'<=$6::text AND row->>'status'='absent')::int AS absent_days,
        COUNT(DISTINCT row->>'date') FILTER (WHERE row->>'date'<=$6::text AND row->>'status'='leave-approved')::int AS leave_days,
        COUNT(DISTINCT row->>'date') FILTER (WHERE row->>'date'<=$6::text AND row->>'status'='in-consideration')::int AS pending_days,
        json_agg(row ORDER BY (row->>'date'>$6::text),row->>'date' DESC) AS days
      FROM combined GROUP BY row->>'employee_kind',row->>'employee_id'
    )
    SELECT (SELECT COALESCE(json_agg(e ORDER BY e.is_attendance_blocked,e.full_name,e.employee_kind,e.employee_id),'[]'::json)
      FROM (SELECT * FROM employees ORDER BY is_attendance_blocked,full_name,employee_kind,employee_id LIMIT 50 OFFSET $7) e) AS data,
      (SELECT COUNT(*)::int FROM employees) AS total,
      (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM
        (SELECT row->>'status' AS status,COUNT(*)::int AS n FROM combined GROUP BY row->>'status') counts) AS summary` };
}
module.exports = { employeeSummaryQuery };
