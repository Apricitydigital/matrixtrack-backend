const router=require('express').Router(),pool=require('../config/db');
const auth=require('../middleware/authMiddleware');
const {attachCityScope,requireCityScope}=require('../middleware/cityScope');
const {attachKothiScope}=require('../middleware/kothiScope');
const {modeJoin,modeFields}=require('../utils/employeeAttendanceMode');
router.use(auth,attachKothiScope,attachCityScope,requireCityScope());
router.post('/',async(req,res)=>{try{
 const ids=req.body.emp_ids;
 const date=req.body.date;
 if(date!==undefined&&date!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))return res.status(400).json({success:false,message:'Choose a valid date.'});
 if(!Array.isArray(ids)||ids.length>200||ids.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<1||Number(id)>2147483647))return res.status(400).json({success:false,message:'Choose up to 200 employees.'});
 const rows=(await pool.query(`SELECT e.emp_id,${modeFields},a.register_status,a.register_marked_by_name,
  a.supervisor_in_name,a.supervisor_out_name FROM employee e JOIN wards w ON w.ward_id=e.ward_id LEFT JOIN zones z ON z.zone_id=w.zone_id ${modeJoin}
  LEFT JOIN attendance a ON a.emp_id=e.emp_id AND a.date=COALESCE($4::date,(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date)
  WHERE e.emp_id=ANY($1::int[]) AND ($2::int[] IS NULL OR e.ward_id=ANY($2)) AND ($3::int[] IS NULL OR z.city_id=ANY($3))`,
 [ids.map(Number),req.kothiScope?.all?null:req.kothiScope?.ids||[],req.cityScope?.all?null:req.cityScope?.ids||[],date||null])).rows;
 if(date===null)for(const row of rows)for(const field of ['register_status','register_marked_by_name','supervisor_in_name','supervisor_out_name'])delete row[field];
 res.json({success:true,data:rows});
 }catch(e){res.status(503).json({success:false,message:'Attendance modes are unavailable.'});}});
module.exports=router;
