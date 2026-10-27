const jwt=require('jsonwebtoken'),crypto=require('node:crypto');
const columns={IN:'punch_in_image',MID_IN:'mid_shift_punch_in_image',OUT:'punch_out_image'};
const direction=value=>String(value||'').trim().toUpperCase()==='OUT'?'OUT':['MID_IN','MID','MIDSHIFT','MID_SHIFT'].includes(String(value||'').trim().toUpperCase())?'MID_IN':'IN';
function key(){if(!process.env.JWT_SECRET)throw Error('JWT secret is required for image access');return crypto.createHmac('sha256',process.env.JWT_SECRET).update('attendance-image-capability-v1').digest();}
const fingerprint=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
function issueImageAccess(id,type,reference){return jwt.sign({attendance_id:String(id),punch_type:direction(type),reference:fingerprint(reference)},key(),{algorithm:'HS256',audience:'attendance-image',issuer:'matrixtrack',expiresIn:900});}
function readImageAccess(token,id,type){const claim=jwt.verify(token,key(),{algorithms:['HS256'],audience:'attendance-image',issuer:'matrixtrack'});if(claim.attendance_id!==String(id)||claim.punch_type!==direction(type))throw Error('Photo scope mismatch');return claim;}
function verifyImageAccess(token,id,type,reference){return readImageAccess(token,id,type).reference===fingerprint(reference);}
async function addAttendanceImageTokens(records){
 for(let i=0;i<records.length;i+=100){
  for(const row of records.slice(i,i+100)){
   if(row.employee_kind!=='regular'||!row.attendance_id)continue;
   for(const [type,column]of Object.entries(columns))if(row[column])row[column+'_token']=issueImageAccess(row.attendance_id,type,row[column]);
  }
  if(i+100<records.length)await new Promise(resolve=>setImmediate(resolve));
 }
}
module.exports={columns,direction,issueImageAccess,readImageAccess,verifyImageAccess,addAttendanceImageTokens};
