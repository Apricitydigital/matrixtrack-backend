// Combine before paginating so totals, status counts and page boundaries cover both populations.
function combinedTeamAttendanceQuery(professionalCte,regularCte,params){
 const order="(row->>'date'>$6::text),row->>'date' DESC,row->>'full_name',row->>'employee_kind',row->>'employee_id'";
 return {params,sql:`WITH professional_rows AS (${professionalCte} SELECT to_jsonb(r) AS row FROM records r),
  regular_rows AS (${regularCte} SELECT to_jsonb(r) AS row FROM records r),
  combined AS (SELECT row FROM professional_rows UNION ALL SELECT row FROM regular_rows)
  SELECT (SELECT COALESCE(json_agg(row ORDER BY ${order}),'[]'::json) FROM
    (SELECT row FROM combined ORDER BY ${order} LIMIT 50 OFFSET $7) paged) AS data,
   (SELECT COUNT(*)::int FROM combined) AS total,
   (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM
     (SELECT row->>'status' AS status,COUNT(*)::int AS n FROM combined GROUP BY row->>'status') counts) AS summary`};
}
module.exports={combinedTeamAttendanceQuery};
