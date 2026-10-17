const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ExcelJS = require('exceljs');
const { PassThrough } = require('node:stream');
const { todayIST } = require('../utils/professionalWeeklyOff');

module.exports = async function verifyRoutes(client) {
  const routers = [];
  const Router = () => {
    const r = { routes: [], use() {} };
    for (const method of ['get','post','put']) r[method] = (url,...handlers) => r.routes.push({ method,url,handlers });
    routers.push(r); return r;
  };
  const tx = { release() {}, async query(sql,params=[]) {
    if (sql === 'BEGIN') return client.query('SAVEPOINT route_test');
    if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT route_test');
    if (sql === 'ROLLBACK') { await client.query('ROLLBACK TO SAVEPOINT route_test'); return client.query('RELEASE SAVEPOINT route_test'); }
    return client.query(sql,params);
  } };
  const noop = (req,res,next) => next();
  const dependencies = {
    express: { Router }, multer: require('multer'), exceljs: ExcelJS,
    '../config/db': { query: (sql,params) => client.query(sql,params),connect: async () => tx },
    '../middleware/authMiddleware': noop, '../middleware/professionalAuth': noop,
    '../middleware/cityScope': { attachCityScope: noop }, '../middleware/permissionMiddleware': { authorize: () => noop },
    '../utils/professionalWeeklyOff': require('../utils/professionalWeeklyOff'),
  };
  const moduleRef = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/professionalWeeklyOffRoutes.js'),'utf8'), { require: name => dependencies[name],module:moduleRef,console,Set,Array,Number,String,Date,Promise,Object,Buffer });
  const coordinator='00000000-0000-4000-8000-000000000002';
  const employee='00000000-0000-4000-8000-000000000001';
  await client.query(`INSERT INTO cities(city_id,city_name) VALUES(1,'City A'),(2,'City B');
    INSERT INTO zones(zone_id,city_id,zone_name) VALUES(1,1,'Zone A'),(2,2,'Zone B');
    INSERT INTO wards(ward_id,ward_name,zone_id) VALUES(1,'Site A',1),(2,'Site B',2),(3,'Site C',2);
    UPDATE professional_employees SET zone_id=1 WHERE city_id=1;
    INSERT INTO professional_employees(id,full_name,emp_code,city_id,zone_id,kothi_id) VALUES('00000000-0000-4000-8000-000000000003','Outside','E3',2,2,2),('00000000-0000-4000-8000-000000000004','Unassigned','E4',2,2,3);
    INSERT INTO professional_site_access(professional_id,kothi_id) VALUES('${coordinator}',1);`);
  const run = async (method,url,options={}) => {
    const route=routers[1].routes.find(r=>r.method===method && r.url===url);
    const req={ professional:{professional_id:coordinator},weeklyCanWrite:true,weeklyHod:false,query:{},body:{},...options };
    let res={ code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;},setHeader(){},end(){} };
    if (url === '/template') {
      const stream = new PassThrough();
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      res = Object.assign(stream, res);
      res.templateChunks = chunks;
    }
    if(method==='put' || method==='post') {
      let passed=false;route.handlers[0](req,res,()=>{passed=true;});
      if(!passed) return res;
    }
    await route.handlers.at(-1)(req,res,()=>{}); return res;
  };
  let result=await run('get','/employees');
  assert.equal(result.code,200);assert.equal(result.body.data.length,2);
  result=await run('get','/employees',{query:{site_id:2}});assert.equal(result.code,403);
  result=await run('get','/employees',{weeklyHod:true,weeklyCanWrite:false});assert.equal(result.body.data.length,2,'Head of Department only sees assigned-site employees');
  for (const endpoint of ['/employees','/dashboard','/history','/template']) {
    result=await run('get',endpoint,{weeklyHod:true,weeklyCanWrite:false,query:{site_id:2}});
    assert.equal(result.code,403,`${endpoint} rejects an unassigned site for Head of Department`);
  }
  result=await run('get','/sites',{weeklyHod:true,weeklyCanWrite:false});
  assert.deepEqual(Array.from(result.body.data, site => site.id),[1]);
  result=await run('get','/dashboard',{weeklyHod:true,weeklyCanWrite:false});
  assert.equal(result.body.data.employee_count,2);
  result=await run('get','/template',{weeklyHod:true,weeklyCanWrite:false});
  const scopedTemplate=new ExcelJS.Workbook();
  await scopedTemplate.xlsx.load(Buffer.concat(result.templateChunks));
  assert.equal(scopedTemplate.getWorksheet('Weekly Off').rowCount,3,'template contains header and only two assigned employees');
  await client.query('DELETE FROM professional_site_access WHERE professional_id=$1',[coordinator]);
  for (const weeklyHod of [false,true]) {
    result=await run('get','/sites',{weeklyHod});assert.equal(result.body.data.length,0,'no assignments means no sites');
    result=await run('get','/employees',{weeklyHod});assert.equal(result.body.data.length,0,'no assignments means no employees');
    result=await run('get','/dashboard',{weeklyHod});assert.equal(result.body.data.employee_count,0);
    result=await run('get','/history',{weeklyHod});assert.equal(result.body.data.length,0);
  }
  await client.query('INSERT INTO professional_site_access(professional_id,kothi_id) VALUES($1,1)',[coordinator]);
  result=await run('put','/employees',{weeklyCanWrite:false,weeklyHod:true,body:{rows:[{employee_id:employee,week_off_day:'Monday'}]}});assert.equal(result.code,403);
  const before=(await client.query('SELECT COUNT(*)::int AS n FROM professional_week_off_versions')).rows[0].n;
  result=await run('put','/employees',{body:{rows:[{employee_id:employee,week_off_day:'Friday'},{employee_id:'E3',week_off_day:'Friday'}]}});
  assert.equal(result.code,400);assert.equal(result.body.errors.length,1);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM professional_week_off_versions')).rows[0].n,before,'invalid batch saves no rows');
  result=await run('put','/employees',{weeklyHod:true,body:{rows:[{employee_id:'E3',week_off_day:'Friday'}]}});assert.equal(result.code,400,'dual designation cannot write outside coordinator sites');
  result=await run('put','/employees',{body:{rows:[{employee_id:'E1',week_off_day:'Friday'},{employee_id:employee,week_off_day:'Saturday'}]}});assert.equal(result.code,400,'duplicate IDs/codes for one person rejected');
  result=await run('put','/employees',{body:{rows:[{employee_id:'E1',week_off_day:'Friday'}],effective_from:'2000-01-01'}});assert.equal(result.code,400);
  result=await run('put','/employees',{body:{rows:[{employee_id:'E1',week_off_day:'Friday'}]}});assert.equal(result.code,200);
  assert.deepEqual((await client.query('SELECT professional_week_off_days_at($1,$2::date) AS days',[employee,todayIST()])).rows[0].days,[5]);
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Weekly Off');
  sheet.addRow(['Employee Name','Employee ID','Assigned Site','Weekly-Off Day']);sheet.addRow(['Employee','E1','Site A','Saturday']);
  result=await run('post','/upload',{file:{originalname:'template.xlsx',buffer:await book.xlsx.writeBuffer()}});assert.equal(result.code,200);
  assert.deepEqual((await client.query('SELECT professional_week_off_days_at($1,$2::date) AS days',[employee,todayIST()])).rows[0].days,[6]);
  sheet.getCell('C2').value='Site B';
  result=await run('post','/upload',{file:{originalname:'template.xlsx',buffer:await book.xlsx.writeBuffer()}});assert.equal(result.code,400,'wrong site rejected');
  await client.query(`INSERT INTO professional_week_off(professional_id,week_off_days,effective_from,updated_by_professional) VALUES('00000000-0000-4000-8000-000000000003',ARRAY[4],$1,$2)`,[todayIST(),coordinator]);
  result=await run('get','/history',{weeklyHod:true});assert.equal(result.code,200);assert.ok(result.body.data.length>0);
  assert.ok(result.body.data.every(row=>row.professional_id!=='00000000-0000-4000-8000-000000000003'),'history excludes unassigned employees');
  result=await run('get','/dashboard');assert.equal(result.code,200);assert.ok(result.body.data.coordinators.length>0);
  await client.query("INSERT INTO users(user_id,name) VALUES(1,'MT Admin')");
  const designationIds=(await client.query('SELECT designation_id FROM designation ORDER BY designation_id')).rows.map(d=>d.designation_id);
  const assign=async(cityScope,body)=>{
    const route=routers[0].routes.find(r=>r.method==='put');
    const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await route.handlers.at(-1)({user:{user_id:1},params:{id:coordinator},cityScope,body},res);return res;
  };
  result=await assign({all:false,ids:[1]},{designation_ids:designationIds,site_ids:[1,2]});assert.equal(result.code,403);
  result=await assign({all:true},{designation_ids:designationIds,site_ids:[1,2]});assert.equal(result.code,200);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM professional_site_access WHERE professional_id=$1',[coordinator])).rows[0].n,2);
  for (const weeklyHod of [false,true]) {
    result=await run('get','/sites',{weeklyHod});
    assert.deepEqual(Array.from(result.body.data, site => site.id),[1,2],'two assigned sites exclude third site');
    result=await run('get','/employees',{weeklyHod});
    assert.equal(result.body.data.length,3,'only employees of two assigned sites');
    result=await run('get','/dashboard',{weeklyHod});assert.equal(result.body.data.employee_count,3);
    result=await run('get','/employees',{weeklyHod,query:{site_id:3}});assert.equal(result.code,403);
  }
  result=await assign({all:false,ids:[1]},{designation_ids:designationIds,site_ids:[1]});assert.equal(result.code,403,'partial-city admins cannot remove assignments in another city');
  result=await assign({all:true},{designation_ids:[999],site_ids:[1]});assert.equal(result.code,400);
  console.log('PASS: site scope, Head of Department read access, dual-role write restrictions, atomic batches, duplicates, effective dates, Excel upload and coordinator counts.');
};
