const fs=require("fs");
const pool=require("./config/db");
const inventory=fs.readFileSync("all_s3_keys.txt","utf8").split(/\r?\n/);
const counts=new Map();
for(const line of inventory){const m=line.match(/faces\/(\d+)\//); if(!m) continue; const id=Number(m[1]); if(!Number.isFinite(id)) continue; counts.set(id,(counts.get(id)||0)+1);}
const multi=[...counts.entries()].filter(([_,c])=>c>1);
if(!multi.length){console.log('none'); process.exit(0);} 
const ids=multi.map(([id])=>id);
(async()=>{
  const {rows}=await pool.query(`
    SELECT e.emp_id,
           e.emp_code,
           e.name,
           w.ward_id        AS kothi_id,
           w.ward_name      AS kothi_name,
           s.sector_id      AS ward_no,
           s.sector_name    AS ward_name,
           z.zone_id,
           z.zone_name,
           c.city_id,
           c.city_name
      FROM employee e
      LEFT JOIN wards w   ON e.ward_id = w.ward_id
      LEFT JOIN sectors s ON w.sector_id = s.sector_id
      LEFT JOIN zones z   ON w.zone_id = z.zone_id
      LEFT JOIN cities c  ON z.city_id = c.city_id
     WHERE e.emp_id = ANY($1)
  `,[ids]);
  const countMap = Object.fromEntries(multi);
  const merged = rows.map(r=>({
    emp_id: r.emp_id,
    images: countMap[r.emp_id]||0,
    emp_code: r.emp_code,
    name: r.name,
    city: r.city_name || null,
    zone: r.zone_name || null,
    ward_no: r.ward_no || null,
    ward_name: r.ward_name || null,
    kothi_id: r.kothi_id || null,
    kothi_name: r.kothi_name || null,
  })).sort((a,b)=>b.images-a.images || a.emp_id-b.emp_id);
  console.log(JSON.stringify(merged,null,2));
  await pool.end();
})();
