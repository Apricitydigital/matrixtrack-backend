const router=require('express').Router();
const pool=require('../config/db');
const authenticate=require('../middleware/authMiddleware');
const {ensurePunchCutoffSchema,getPunchSettings}=require('../utils/professionalPunchCutoff');
const normalize=value=>String(value || '').trim().toLowerCase();
router.use(authenticate);
router.use(async(req,res,next)=>{
  try {
    const id=req.user?.user_id || req.user?.id || req.user?.userId;
    const {rows}=await pool.query('SELECT user_id,email,role,permissions,is_deleted FROM users WHERE user_id=$1',[id]);
    const user=rows[0];
    let permissions=user?.permissions || {};
    if(typeof permissions==='string') {try {permissions=JSON.parse(permissions);} catch {permissions={};}}
    const emails=[process.env.SUPER_ADMIN_EMAIL || 'mtadmin@apricitydigital.in',process.env.SUPER_ADMIN_DB_EMAIL || 'admin@gmail.com'].map(normalize);
    if(!user || user.is_deleted===true || !(emails.includes(normalize(user.email)) || normalize(user.role)==='super_admin' || normalize(permissions.role_type)==='super_admin')) {
      return res.status(403).json({success:false,message:'Only Superadmin can manage the punch-in restriction.'});
    }
    req.punchSettingActor=user.user_id;
    await ensurePunchCutoffSchema(); next();
  } catch(e) {console.error('[PunchSettings]',e);res.status(500).json({success:false,message:'Unable to validate punch-in settings access.'});}
});
router.get('/',async(req,res)=>{
  try {res.json({success:true,data:await getPunchSettings()});}
  catch(e) {res.status(500).json({success:false,message:'Unable to load punch-in settings.'});}
});
router.patch('/',async(req,res)=>{
  if(typeof req.body?.enabled!=='boolean') return res.status(400).json({success:false,message:'enabled must be true or false.'});
  let client;
  try {
    client=await pool.connect();
    await client.query('BEGIN');
    const previous=(await client.query('SELECT enabled FROM professional_punch_settings WHERE id=1 FOR UPDATE')).rows[0];
    const {rows}=await client.query(`UPDATE professional_punch_settings SET enabled=$1,updated_by=$2,updated_at=NOW()
      WHERE id=1 RETURNING enabled,updated_by,updated_at`,[req.body.enabled,req.punchSettingActor]);
    if(previous.enabled!==req.body.enabled) await client.query(`INSERT INTO professional_punch_setting_history(old_enabled,enabled,actor_user_id) VALUES($1,$2,$3)`,[previous.enabled,req.body.enabled,req.punchSettingActor]);
    await client.query('COMMIT');res.json({success:true,data:rows[0]});
  } catch(e) {if(client) await client.query('ROLLBACK');console.error('[PunchSettings]',e);res.status(500).json({success:false,message:'Unable to update punch-in restriction.'});}
  finally {client?.release();}
});
module.exports=router;
