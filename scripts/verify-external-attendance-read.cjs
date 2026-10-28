// Read-only smoke test of SQL against the configured database. Prints counts only.
const path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
require('dotenv').config({path:path.join(__dirname,'../.env'),quiet:true});
const {Client}=require('pg');
const db=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
 ssl:{rejectUnauthorized:false},connectionTimeoutMillis:12000,statement_timeout:20000,options:'-c default_transaction_read_only=on'});
const filename=path.join(__dirname,'../controllers/externalAttendanceReadController.js'),moduleRef={exports:{}};
const photos=require('../utils/supervisorAttendancePhotos');
vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:moduleRef,process,console,URL,require:name=>{
 if(name==='../config/db')return db;
 // Exercise real photo field selection and token construction without publishing links or contacting storage.
 if(name==='../utils/s3SelfPunch')return {getSignedS3Url:async key=>key?'https://verification.invalid/photo':null};
 if(name==='../utils/supervisorAttendancePhotos')return {...photos,signSupervisorAttendancePhotos:(rows,pool)=>photos.signSupervisorAttendancePhotos(rows,pool,async()=> 'https://verification.invalid/photo')};
 return require(require.resolve(name,{paths:[path.dirname(filename)]}));
}});
(async()=>{try{
 await db.connect();
 const date=process.argv[2] || new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
 const checks=[['getDailyAttendance',{date,limit:1}],['getFullAttendance',{date,limit:1}],['getFullAttendance',{date,employee_type:'professional',limit:1}],
  ['getAttendanceSummary',{date}],['getEmployees',{limit:1}],['getSupervisors',{limit:1}]];
 for(const [method,query] of checks){
  const res={code:200,status(code){this.code=code;return this;},set(){return this;},json(body){this.body=body;return this;}};
  await moduleRef.exports[method]({query,params:{},apiKey:{}},res);
  console.log(JSON.stringify({method,type:query.employee_type,status:res.code,rows:Array.isArray(res.body.data)?res.body.data.length:undefined,total:res.body.pagination?.total,error:res.body.error?.code}));
  if(res.code!==200)throw Error(`${method} failed its read-only schema check`);
 }
}finally{await db.end()}})().catch(error=>{console.error(error.message);process.exitCode=1;});
