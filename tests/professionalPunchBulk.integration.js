const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const vm=require('vm');
const ExcelJS=require('exceljs');const {PassThrough}=require('node:stream');
const {HEADERS,parseCutoff}=require('../utils/professionalPunchImport');
module.exports=async function verifyBulk(client,pool,utility) {
  const person='00000000-0000-4000-8000-000000000001',outside='00000000-0000-4000-8000-000000000005',duplicate='00000000-0000-4000-8000-000000000006';
  await client.query(`INSERT INTO cities VALUES(2,'Bhopal');
    CREATE TABLE zones(zone_id INT PRIMARY KEY,zone_name TEXT);
    UPDATE professional_employees SET city_id=2 WHERE id='${outside}';
    INSERT INTO professional_employees(id,full_name,emp_code,kothi_id,city_id) VALUES('${duplicate}','Duplicate code','E1',2,2);
    UPDATE users SET permissions='{"modules":{"professional_punch_time":"view"},"assigned_cities":[1]}'::jsonb WHERE user_id=2;`);
  const evaluate=(filename,deps)=>{
    const ref={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,filename),'utf8'),{require:name=>{if(!(name in deps)) throw new Error('Unexpected dependency '+name);return deps[name];},module:ref,console,Map,Set,Array,String,Number,Object,Date,Promise,Buffer,JSON,Math,process:{env:{}}});return ref.exports;
  };
  // Use the real permission middleware against PostgreSQL, including the
  // existing admin module representation and Write => View behavior.
  const permission=evaluate('../middleware/permissionMiddleware.js',{'../config/db':pool,'../utils/userCityAccess':{fetchUserCityAccess:async()=>({all:false,ids:[1]})}});
  const router={routes:[],middleware:[],use(...handlers){this.middleware.push(...handlers);}};
  for(const method of ['get','post','put']) router[method]=(url,...handlers)=>router.routes.push({method,url,handlers});
  const attachCityScope=(req,res,next)=>{
    const ids=req.user.permissions?.assigned_cities || [];
    req.cityScope=ids.length ? {all:false,ids} : {all:true,ids:[]};next();
  };
  // ExcelJS tests row values with instanceof Array. Normalize arrays crossing
  // the VM boundary so the fixture behaves like normal Node module loading.
  class FixtureWorkbook extends ExcelJS.Workbook {
    addWorksheet(...args) {
      const sheet=super.addWorksheet(...args);const addRow=sheet.addRow.bind(sheet);
      sheet.addRow=(values,...options)=>addRow(Array.isArray(values) ? Array.from(values) : values,...options);
      return sheet;
    }
  }
  evaluate('../routes/professionalPunchBulkRoutes.js',{'express':{Router:()=>router},'multer':require('multer'),'exceljs':{Workbook:FixtureWorkbook},'../config/db':pool,
    '../middleware/authMiddleware':(req,res,next)=>next(),'../middleware/cityScope':{attachCityScope},'../middleware/permissionMiddleware':permission,
    '../utils/professionalPunchCutoff':utility,'../utils/professionalPunchImport':require('../utils/professionalPunchImport')});
  async function run(method,url,actor=2,options={}) {
    const req={user:{user_id:actor,role:'admin',permissions:{role_type:'super_admin'}},query:{},body:{},headers:{},...options};
    let res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
    let chunks=[];
    if(url==='/download') {
      res=new PassThrough();res.code=200;res.status=n=>{res.code=n;return res;};res.json=body=>{res.body=body;res.end();return res;};res.setHeader=()=>{};
      res.on('data',chunk=>chunks.push(chunk));
    }
    const middleware=router.middleware.filter(h=>h.length!==4);
    const handlers=[...middleware,...router.routes.find(r=>r.method===method && r.url===url).handlers];
    for(const handler of handlers) {
      let proceed=false;
      await handler(req,res,e=>{if(e) throw e;proceed=true;});
      if(!proceed) break;
    }
    if(chunks.length) res.buffer=Buffer.concat(chunks);
    return res;
  }
  async function file(rows,sheetName='Punch-in Times') {
    const book=new ExcelJS.Workbook();const sheet=book.addWorksheet(sheetName);
    sheet.addRow(HEADERS);for(const row of rows) sheet.addRow(row);
    return {originalname:'times.xlsx',buffer:await book.xlsx.writeBuffer()};
  }
  const row=(code,time,city='',site='')=>[code,'',city,'',site,'',time];
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM permissions WHERE module='professional-punch-time'")).rows[0].n,2,'both View and Write seeded');
  let result=await run('get','/catalog');assert.equal(result.code,200);assert.equal(result.body.data.length,4,JSON.stringify(result.body));assert.ok(result.body.data.every(p=>p.city_id===1));assert.ok(result.body.cities.every(c=>c.id===1));
  assert.equal((await run('put','/employees/:employee',2,{params:{employee:person},body:{cutoff_time:'09:30'}})).code,403,'View-only admin cannot edit directly');
  assert.equal((await run('post','/preview',2,{file:await file([row('E1','09:30')])})).code,403,'View-only admin cannot preview imports');
  assert.equal((await run('post','/import',2,{file:await file([row('E1','09:30')])})).code,403,'View-only admin cannot import');
  result=await run('get','/download');assert.equal(result.code,200);
  const scoped=new ExcelJS.Workbook();await scoped.xlsx.load(result.buffer);
  assert.equal(scoped.getWorksheet('Punch-in Times').getRow(1).getCell(1).text,'Employee Code');
  assert.ok(scoped.getWorksheet('Instructions'));assert.equal(scoped.getWorksheet('Punch-in Times').rowCount,5);
  const reference=scoped.getWorksheet('City & Site Reference');
  assert.ok(reference);assert.equal(reference.rowCount,2,'One mapping per city/site, without repeated employee rows');
  assert.equal(reference.getRow(2).getCell(1).value,1);assert.equal(reference.getRow(2).getCell(2).text,'Indore');
  assert.equal(reference.getRow(2).getCell(4).value,1);assert.equal(reference.getRow(2).getCell(5).text,'Solaris');
  assert.equal((await run('get','/download',2,{query:{city_id:2}})).code,403);
  result=await run('get','/download',1,{query:{group_by:'city'}});
  assert.equal(result.code,200,JSON.stringify(result.body));
  const grouped=new ExcelJS.Workbook();await grouped.xlsx.load(result.buffer);
  assert.equal(grouped.worksheets.filter(s=>s.name.startsWith('C') && s.name!=='City & Site Reference').length,2);
  assert.equal(grouped.getWorksheet('City & Site Reference').rowCount,3,'Full-scope export includes both authorized city/site mappings');
  assert.ok(grouped.worksheets.find(s=>s.name.startsWith('C2')));
  for(const sheet of grouped.worksheets.filter(s=>!['Instructions','City & Site Reference'].includes(s.name))) sheet.eachRow((row,i)=>{if(i>1) row.getCell(7).value='10:15';});
  result=await run('post','/preview',1,{file:{originalname:'city-sheets.xlsx',buffer:await grouped.xlsx.writeBuffer()}});
  assert.equal(result.code,200);assert.equal(result.body.data.length,6,'City-wise workbook can be re-imported across employee sheets');
  result=await run('get','/download',1,{query:{city_id:2,site_id:2,group_by:'site'}});
  const siteBook=new ExcelJS.Workbook();await siteBook.xlsx.load(result.buffer);
  assert.equal(siteBook.worksheets.filter(s=>!['Instructions','City & Site Reference'].includes(s.name)).length,1);assert.equal(siteBook.worksheets[0].rowCount,3);
  const siteReference=siteBook.getWorksheet('City & Site Reference');
  assert.equal(siteReference.rowCount,2);assert.equal(siteReference.getRow(2).getCell(2).text,'Bhopal');assert.equal(siteReference.getRow(2).getCell(5).text,'Outside');
  await client.query(`UPDATE users SET permissions='{"modules":{"professional_punch_time":"write"},"assigned_cities":[1]}'::jsonb WHERE user_id=2`);
  const edit=(employee,cutoff_time,options={})=>run('put','/employees/:employee',2,{params:{employee},body:{cutoff_time},...options});
  for(const time of ['',null,'24:00','09:60','9:30','09:30:00']) assert.equal((await edit(person,time)).code,400);
  assert.equal((await edit('invalid','09:30')).code,400);
  assert.equal((await edit(outside,'09:30')).code,403,'Direct edits enforce assigned cities');
  assert.equal((await edit(person,'09:30',{query:{site_id:2}})).code,403,'Direct edits enforce selected site');
  const snapshot=(await client.query('SELECT punch_approval_status,punch_cutoff FROM professional_attendance WHERE professional_id=$1',[person])).rows[0];
  const oldDirect=(await client.query('SELECT cutoff_time FROM professional_punch_cutoffs WHERE professional_id=$1',[person])).rows[0].cutoff_time;
  assert.equal((await edit(person,'00:00')).code,200,'Midnight is a valid direct cutoff');
  const directAudit=(await client.query('SELECT actor_user_id,old_time::text,new_time::text FROM professional_punch_activity WHERE professional_id=$1 ORDER BY id DESC LIMIT 1',[person])).rows[0];
  assert.equal(directAudit.actor_user_id,2);assert.equal(directAudit.old_time,oldDirect);assert.equal(directAudit.new_time,'00:00:00');
  assert.deepEqual((await client.query('SELECT punch_approval_status,punch_cutoff FROM professional_attendance WHERE professional_id=$1',[person])).rows[0],snapshot,'Direct edit preserves attendance snapshots');
  await client.query('UPDATE professional_employees SET is_active=FALSE WHERE id=$1',[person]);
  assert.equal((await edit(person,'10:00')).code,403,'Inactive employees cannot be edited');
  await client.query('UPDATE professional_employees SET is_active=TRUE WHERE id=$1',[person]);
  const initial=(await client.query('SELECT cutoff_time FROM professional_punch_cutoffs WHERE professional_id=$1',[person])).rows[0].cutoff_time;
  result=await run('post','/preview',2,{file:await file([row('E1','09:30')])});assert.equal(result.code,200);assert.equal(result.body.data[0].new_time,'09:30');
  assert.equal((await client.query('SELECT cutoff_time FROM professional_punch_cutoffs WHERE professional_id=$1',[person])).rows[0].cutoff_time,initial,'Preview is read-only');
  result=await run('post','/import',2,{file:await file([row('E1','09:30'),row('E5','10:00')])});assert.equal(result.code,400);assert.ok(result.body.errors.some(e=>e.employee_code==='E5'));
  assert.equal((await client.query('SELECT cutoff_time FROM professional_punch_cutoffs WHERE professional_id=$1',[person])).rows[0].cutoff_time,initial,'Invalid scope rejects entire batch');
  for(const rows of [[row('E1','25:00')],[row('E1','09:30'),row('E1','10:00')],[row('E1','')],[row('UNKNOWN','09:30')]]) assert.equal((await run('post','/import',2,{file:await file(rows)})).code,400);
  result=await run('post','/preview',1,{file:await file([row('E1','09:30')])});assert.equal(result.code,400,'Duplicate codes across cities require context');
  result=await run('post','/preview',1,{file:await file([row('E1','09:30',2,2)])});assert.equal(result.code,200);assert.equal(result.body.data[0].id,duplicate);
  const pendingBefore=(await client.query('SELECT punch_approval_status,punch_cutoff FROM professional_attendance WHERE professional_id=$1',[outside])).rows[0];
  result=await run('post','/import',1,{file:await file([row('E5','11:00',2,2)])});assert.equal(result.code,200);
  const pendingAfter=(await client.query('SELECT punch_approval_status,punch_cutoff FROM professional_attendance WHERE professional_id=$1',[outside])).rows[0];
  assert.deepEqual(pendingAfter,pendingBefore,'Bulk changes preserve existing late request snapshots');
  result=await run('post','/import',2,{file:await file([row('E1',0.375)])});assert.equal(result.code,200,'Excel numeric 09:00 time supported');
  const saved=(await client.query('SELECT cutoff_time,updated_by,updated_by_user FROM professional_punch_cutoffs WHERE professional_id=$1',[person])).rows[0];
  assert.equal(saved.cutoff_time,'09:00:00');assert.equal(saved.updated_by,null);assert.equal(saved.updated_by_user,2);
  result=await run('get','/history',2);assert.equal(result.body.data[0].actor_name,'Admin');assert.equal(result.body.data[0].actor_type,'Admin');
  assert.ok(result.body.data.every(r=>r.city_name!=='Bhopal'));
  const adminAudit=(await client.query(`SELECT actor_user_id,actor_id,old_time::text,new_time::text FROM professional_punch_activity WHERE professional_id=$1 AND actor_user_id=2 ORDER BY id DESC LIMIT 1`,[person])).rows[0];
  assert.equal(adminAudit.actor_user_id,2);assert.equal(adminAudit.actor_id,null);assert.equal(adminAudit.new_time,'09:00:00');
  result=await run('post','/preview',2,{file:await file([row('E1',{formula:'TIME(9,0,0)',result:0.375})])});assert.equal(result.code,400,'Cached formulas rejected');
  await client.query(`UPDATE users SET permissions='{"modules":{"professional_punch_time":false},"assigned_cities":[1]}'::jsonb WHERE user_id=2`);
  assert.equal((await run('get','/catalog',2)).code,403,'Superadmin revocation denies direct API access');
  assert.equal((await run('post','/import',2,{file:await file([row('E1','08:00')])})).code,403);
  assert.equal((await edit(person,'08:00')).code,403,'Revocation denies direct editing');
  assert.equal(parseCutoff('9:30 AM'),'09:30');assert.equal(parseCutoff('12:00 AM'),'00:00');assert.equal(parseCutoff('12:00 PM'),'12:00');assert.throws(()=>parseCutoff(1),/Invalid/);
  console.log('PASS: real RBAC View/Write/revocation, city/site exports, Excel preview/import, ambiguity, atomic rejection, admin audit and pending snapshot preservation.');
};
