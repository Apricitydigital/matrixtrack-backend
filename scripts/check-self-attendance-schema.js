'use strict';
require('dotenv').config();
const pool=require('../config/db');
(async()=>{
 try{
  const {rows}=await pool.query("SELECT to_regclass('public.self_attendance_employees') IS NOT NULL AS ready,to_regclass('public.professional_employees') IS NOT NULL AS legacy");
  if(!rows[0]?.ready||rows[0].legacy)throw Error('Run the reviewed Self Attendance naming migration during maintenance before deploying this backend. See docs/self-attendance-rename.md.');
  console.log('Self Attendance database names are ready.');
 }finally{await pool.end();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
