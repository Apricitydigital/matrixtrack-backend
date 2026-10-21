const crypto = require('crypto');

// Raw records deliberately bypass the reporting identity projection. Never merge by name.
const recordsSql = `WITH records AS (
 SELECT 'regular'::text AS kind,e.emp_id::text AS id,e.name AS name,e.emp_code,e.phone AS mobile,
 c.city_id,c.city_name,w.ward_name AS site_name,e.ward_id AS site_id,
 to_jsonb(e)->>'is_active' AS active,to_jsonb(e)->>'is_deleted' AS deleted,
 (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL) AS face_registered
 FROM employee e LEFT JOIN wards w ON w.ward_id=e.ward_id
 LEFT JOIN zones z ON z.zone_id=w.zone_id LEFT JOIN cities c ON c.city_id=z.city_id
 UNION ALL
 SELECT 'professional',p.id::text,p.full_name,p.emp_code,p.mobile,p.city_id,c.city_name,w.ward_name,p.kothi_id,
 p.is_active::text,to_jsonb(p)->>'is_deleted',p.selfie_url IS NOT NULL
 FROM professional_employees p LEFT JOIN cities c ON c.city_id=p.city_id
 LEFT JOIN wards w ON w.ward_id=p.kothi_id
), scoped AS (
 SELECT * FROM records WHERE ($1::int[] IS NULL OR city_id=ANY($1))
 AND ($2::int[] IS NULL OR site_id=ANY($2))
)`;

function summarize(rows) {
 const result = { totalEmployees: rows.length, totalFaceRegistered: 0, present: 0, inProgress: 0, onLeave: 0, notMarked: 0, midShiftPunchIn: 0 };
 for (const row of rows) {
   if (row.face_registered) result.totalFaceRegistered++;
   if (row.status === 'present') { result.present++; if (!row.punched_out) result.inProgress++; }
   else if (row.status === 'onLeave') result.onLeave++;
   else result.notMarked++;
   if (row.mid_shift) result.midShiftPunchIn++;
 }
 result.marked = result.present - result.inProgress;
 result.attendanceRate = rows.length ? Number(((result.present + result.onLeave) / rows.length * 100).toFixed(1)) : 0;
 return result;
}
const quote = value => '"' + value.replace(/"/g, '""') + '"';

// Traverse real FK relationships so preview and deletion use the same dependency plan.
// No wildcard deletes, disabled constraints, or deletion of identity-linked profiles.
async function deletionPlan(client, kind, id) {
 const root = kind === 'regular' ? 'employee' : 'professional_employees';
 const key = kind === 'regular' ? 'emp_id' : 'id';
 const plan = [];
 async function visit(table, predicate, path) {
   const state = (await client.query(`SELECT count(*) AS count,
     md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest
     FROM ${quote(table)} t WHERE ${predicate}`, [id])).rows[0];
   const count = Number(state.count);
   if (!count) return;
   if (path.includes(table)) throw Object.assign(new Error('Cyclic dependencies require manual review.'), { status: 409 });
   const links = (await client.query(`SELECT child.relname AS child,ca.attname AS child_key,pa.attname AS parent_key,
     cardinality(f.conkey) AS columns,child_ns.nspname=current_schema() AS local FROM pg_constraint f
     JOIN pg_class parent ON parent.oid=f.confrelid JOIN pg_namespace ns ON ns.oid=parent.relnamespace
     JOIN pg_class child ON child.oid=f.conrelid
     JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
     JOIN pg_attribute ca ON ca.attrelid=f.conrelid AND ca.attnum=f.conkey[1]
     JOIN pg_attribute pa ON pa.attrelid=f.confrelid AND pa.attnum=f.confkey[1]
     WHERE f.contype='f' AND ns.nspname=current_schema() AND parent.relname=$1 ORDER BY child.relname,ca.attname`, [table])).rows;
   for (const link of links) {
     if (!link.local) throw Object.assign(new Error('Dependencies in another schema require manual review.'), { status: 409 });
     if (link.columns !== 1) throw Object.assign(new Error('Composite dependencies require manual review.'), { status: 409 });
     await visit(link.child, `${quote(link.child_key)} IN (SELECT ${quote(link.parent_key)} FROM ${quote(table)} WHERE ${predicate})`, [...path,table]);
   }
   plan.push({ table, predicate, count, digest: state.digest });
 }
 await visit(root, `${quote(key)}::text=$1`, []);
 return plan;
}
const fingerprint = plan => crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
module.exports = { recordsSql, summarize, deletionPlan, fingerprint, quote };
