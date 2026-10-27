const pool=require('../config/db'),authenticate=require('./authMiddleware'),crypto=require('node:crypto');
const {attachCityScope}=require('./cityScope'),{attachKothiScope}=require('./kothiScope');
const {columns,direction,readImageAccess,verifyImageAccess}=require('../utils/attendanceImageAccess');
const {authorize}=require('./permissionMiddleware');
const pathOf=req=>String(req.path||req.url||'').split('?')[0].replace(/\/+$/,'').toLowerCase();
module.exports=function attendanceImageGuard(req,res,next){
 if(!['GET','HEAD'].includes(req.method)||pathOf(req)!=='/app/attendance/employee/image')return next();
 res.set('Cache-Control','private, no-store');res.set('Referrer-Policy','no-referrer');
 const id=req.query?.attendance_id,type=direction(req.query?.punch_type);
 if(typeof id!=='string'||!(/^[1-9]\d*$/.test(id)||/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))||typeof req.query?.punch_type!=='string')return res.status(400).json({error:'Choose a valid attendance photo.'});
 if(req.query.image_access)try{readImageAccess(req.query.image_access,id,type);}catch(_){return res.status(403).json({error:'Photo link has expired or is invalid. Refresh the report.'});}
 const check=async()=>{
  try{
   const row=(await pool.query(`SELECT a.emp_id,COALESCE(a.ward_id,e.ward_id) AS ward_id,z.city_id,e.emp_code,
    COALESCE(e.self_attendance_enabled,FALSE) AS self_attendance_enabled,a.${columns[type]} AS reference
    FROM attendance a JOIN employee e ON e.emp_id=a.emp_id LEFT JOIN wards w ON w.ward_id=COALESCE(a.ward_id,e.ward_id)
    LEFT JOIN zones z ON z.zone_id=w.zone_id WHERE a.attendance_id=$1`,[id])).rows[0];
   if(!row?.reference)return res.status(404).json({error:'Image not found'});
   if(req.query.image_access){
    try{if(verifyImageAccess(req.query.image_access,id,type,row.reference))return next();}catch(_){}
    return res.status(403).json({error:'Photo link has expired or is invalid. Refresh the report.'});
   }
   const user=(await pool.query('SELECT to_jsonb(u) AS record FROM users u WHERE u.user_id=$1',[req.user?.user_id])).rows[0]?.record;
   if(!user||user.is_active===false||user.is_deleted===true)return res.status(403).json({error:'Account is unavailable.'});
   const token=req.cookies?.token||String(req.headers.authorization||'').replace(/^Bearer\s+/i,'')||req.headers['x-access-token']||req.headers.token||req.query.token;
   if(!token)return res.status(401).json({error:'Login required.'});
   // This photo boundary fails closed if session-revocation lookup is unavailable.
   if((await pool.query('SELECT 1 FROM active_sessions WHERE token_hash=$1 AND is_revoked=TRUE LIMIT 1',[crypto.createHash('sha256').update(token).digest('hex')])).rows.length)return res.status(403).json({error:'Session revoked.'});
   const own=String(user.role).toLowerCase()==='employee'&&row.self_attendance_enabled&&user.emp_code&&user.emp_code===row.emp_code;
   if(own){const owners=(await pool.query('SELECT emp_id FROM employee WHERE emp_code=$1',[user.emp_code])).rows;if(owners.length===1&&String(owners[0].emp_id)===String(row.emp_id))return next();}
   const role=String(user.role).toLowerCase();req.user={...req.user,...user,role:['super_admin','superadmin'].includes(role)?'admin':role};
   const scoped=()=>attachKothiScope(req,res,()=>attachCityScope(req,res,()=>{
    const site=req.kothiScope,city=req.cityScope;
    if((site?.all||site?.ids?.some(id=>Number(id)===Number(row.ward_id)))&&(city?.all||city?.ids?.some(id=>Number(id)===Number(row.city_id))))return next();
    res.status(403).json({error:'Photo is outside your assigned access.'});
   }));
   return role==='supervisor'?scoped():authorize('attendance_reports','view')(req,res,scoped);
  }catch(error){res.status(error.code==='22P02'?400:503).json({error:'Unable to verify photo access. Please retry.'});}
 };
 if(req.query.image_access)return check();
 return authenticate(req,res,check);
};
