const pool=require('../config/db');
const knownRelations=new Set();
async function hasRelation(name) {
 if(knownRelations.has(name))return true;
 const {rows}=await pool.query('SELECT to_regclass($1) IS NOT NULL AS available',[name]);
 if(rows[0]?.available)knownRelations.add(name);
 return Boolean(rows[0]?.available);
}
const hasLoginAliases=()=>hasRelation('workforce_professional_login_aliases');
async function ensureMergeSchema() {
 const {rows}=await pool.query(`SELECT to_regclass('workforce_employee_aliases') IS NOT NULL
 AND to_regclass('workforce_professional_login_aliases') IS NOT NULL
 AND to_regclass('workforce_merge_audit') IS NOT NULL
 AND to_regprocedure('workforce_redirect_employee_reference()') IS NOT NULL
 AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
 AND table_name='workforce_merge_audit' AND column_name='attendance_snapshots') AS available`);
 if(!rows[0]?.available)throw Object.assign(new Error('Employee merge is unavailable until the workforce schema upgrade is applied by the deployment administrator.'),{status:503});
}
async function resolveEmployeeAlias(kind,id) {
 if(id===undefined || id===null || id==='') return id;
 // An installation without the optional merge schema must still allow normal
 // login and punching. Never execute DDL on an employee request.
 if(!await hasRelation('workforce_employee_aliases'))return id;
 const {rows}=await pool.query('SELECT target_id FROM workforce_employee_aliases WHERE employee_kind=$1 AND source_id=$2',[kind,String(id)]);
 return rows[0]?.target_id || id;
}
// Run after multipart parsing on punch endpoints too: an older mobile client can
// keep its employee ID while attendance is recorded against the surviving ID.
async function resolveRegularRequest(req,res,next) {
 try {
  for(const object of [req.body,req.query]) if(object) for(const key of ['emp_id','empId','employeeId','employee_id']) {
   if(object[key]!==undefined) object[key]=await resolveEmployeeAlias('regular',object[key]);
  }
  next();
 }catch(error){next(error);}
}
module.exports={ensureMergeSchema,hasLoginAliases,hasRelation,resolveEmployeeAlias,resolveRegularRequest};
