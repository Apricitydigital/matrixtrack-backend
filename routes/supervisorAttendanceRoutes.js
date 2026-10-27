const router=require('express').Router(),pool=require('../config/db'),multer=require('multer');
const auth=require('../middleware/professionalAuth');
const {capabilities}=require('../utils/professionalPunchCutoff');
const service=require('../utils/supervisorAttendance'),faces=require('../utils/supervisorFaceIndex');
const safePerson=({face_id,version,photo_key,source_ref,face_embedding,...safe})=>safe;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1,fields:12}}).single('image');
const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){if(!e.status)console.error('[SupervisorAttendance]',e.message);res.status(e.status||503).json({success:false,...(e.code==='FACE_ALREADY_ASSIGNED'?{code:e.code}:{}),message:e.status?e.message:'Could not confirm the operation. Refresh or retry the same capture.'});}};
router.use(auth);
router.get('/sites',wrap(async(req,res)=>{
 const actor=req.professional.professional_id;if(!(await capabilities(pool,actor)).pm)return res.status(403).json({success:false,message:'Project Head access required.'});
 const result=await pool.query('SELECT w.ward_id AS id,w.ward_name AS name FROM professional_site_access s JOIN wards w ON w.ward_id=s.kothi_id WHERE s.professional_id=$1 ORDER BY w.ward_name',[actor]);res.json({success:true,data:result.rows});
}));
router.get('/employees',wrap(async(req,res)=>{
 await service.context(pool,req.professional.professional_id,req.query.site_id);
 const rows=await service.roster(pool,req.query.site_id);
 res.json({success:true,data:rows.map(safePerson)});
}));
router.get('/employees/:id/photo',wrap(async(req,res)=>{
 await service.context(pool,req.professional.professional_id,req.query.site_id);
 const person=(await service.roster(pool,req.query.site_id)).find(p=>String(p.emp_id)===req.params.id);
 if(!person?.photo_key)return res.status(404).json({success:false,message:'No Supervisor Attendance photo stored.'});
 res.json({success:true,url:await faces.getPhotoUrl(person.photo_key,300)});
}));
router.post('/enroll',upload,wrap(async(req,res)=>res.json({success:true,data:await service.enroll(pool,req.professional.professional_id,req.body,req.file)})));
router.post('/prepare',wrap(async(req,res)=>res.json({success:true,data:safePerson(await service.prepareFace(pool,req.professional.professional_id,req.body))})));
router.post('/punch',upload,wrap(async(req,res)=>res.json({success:true,...await service.punch(pool,req.professional.professional_id,req.body,req.file)})));
router.use((error,req,res,next)=>res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({success:false,message:error.code==='LIMIT_FILE_SIZE'?'Photo must be under 8 MB.':'Photo upload could not be read.'}));
module.exports=router;
