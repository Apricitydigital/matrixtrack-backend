// Real holiday routes/RBAC and PostgreSQL, isolated from live accounts and data.
const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');const vm=require('vm');
const {PGlite}=require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
async function main(){
  const db=new PGlite();let failAudit=false;
  const client={release(){},query:async(sql,params)=>{if(failAudit&&sql.includes('INSERT INTO professional_holiday_logs'))throw Error('Simulated audit failure');return db.query(sql,params);}};
  const pool={query:client.query,connect:async()=>client};
  const load=(file,deps)=>{const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,file),'utf8'),{module,require:name=>{if(!(name in deps))throw Error('Unexpected dependency '+name);return deps[name];},console:{error(){}},process});return module.exports;};
  try{
    await db.exec(`CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,role TEXT,permissions JSONB);
      CREATE TABLE permissions(id SERIAL PRIMARY KEY,module TEXT,action TEXT);
      CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT,zone_name TEXT);
      CREATE TABLE sectors(sector_id INT PRIMARY KEY,zone_id INT,sector_name TEXT);CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT,zone_id INT,sector_id INT);
      CREATE TABLE professional_holidays(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),holiday_date DATE,holiday_name TEXT,description TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,created_by INT,updated_by INT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE UNIQUE INDEX holiday_unique ON professional_holidays(holiday_date,city_id,COALESCE(zone_id,-1),COALESCE(ward_id,-1),COALESCE(kothi_id,-1));
      CREATE TABLE professional_holiday_logs(id UUID DEFAULT gen_random_uuid(),holiday_id UUID,action TEXT,actor_user_id INT,actor_name TEXT,holiday_date DATE,holiday_name TEXT,description TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO cities VALUES(1,'Indore'),(2,'Outside');INSERT INTO zones VALUES(1,1,'Zone A'),(2,2,'Zone B');
      INSERT INTO sectors VALUES(1,1,'Sector A'),(2,2,'Sector B');INSERT INTO wards VALUES(1,'Site A',1,1),(2,'Site B',NULL,1),(3,'Outside Site',2,2);
      INSERT INTO users VALUES(1,'Owner','admin',NULL),
      (2,'Viewer','admin','{"modules":{"professional_holiday_declare":"view"}}'),
      (3,'Writer','admin','{"modules":{"professional_holiday_declare":"write"},"assigned_cities":[1]}'),
      (4,'No access','admin','{"modules":{}}'),
      (5,'Inactive','admin','{"is_active":false,"modules":{"professional_holiday_declare":"write"}}'),
      (6,'Assigned site only','admin','{"modules":{"professional_holiday_declare":"write"},"assigned_cities":[1]}');`);
    const migration=fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_holiday_permissions.sql'),'utf8');await db.exec(migration);await db.exec(migration);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM permissions')).rows[0].n,2);
    const scope=async user=>{const p=(await db.query('SELECT permissions FROM users WHERE user_id=$1',[user.user_id])).rows[0].permissions;return p?.assigned_cities?{all:false,ids:p.assigned_cities}:{all:true,ids:[]};};
    const rbac=load('../middleware/permissionMiddleware.js',{'../config/db':pool,'../utils/userCityAccess':{fetchUserCityAccess:scope,invalidateCityAccessCache(){}}});
    const router={middleware:[],routes:[],use(...fns){this.middleware.push(...fns);}};
    for(const method of ['get','post','delete'])router[method]=(url,...handlers)=>router.routes.push({method,url,handlers});
    load('../routes/professionalHolidayRoutes.js',{
      express:{Router:()=>router},'../config/db':pool,'../middleware/authMiddleware':(req,res,next)=>next(),
      '../middleware/cityScope':{attachCityScope:async(req,res,next)=>{req.cityScope=await scope(req.user);next();}},
      '../middleware/permissionMiddleware':rbac,'../utils/userKothiAccess':{fetchUserKothiAccess:async user=>user.user_id===6?{ids:[1]}:{all:true,ids:[]}},
      '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},
    });
    async function run(method,url,user,body={},query={},params={}){
      const req={user:{user_id:user,role:'admin'},body,query,params};const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
      for(const fn of [...router.middleware,...router.routes.find(r=>r.method===method&&r.url===url).handlers]){let next=false;await fn(req,res,()=>{next=true;});if(!next)break;}
      return res;
    }
    const holiday={site_ids:[1,2],holiday_date:'2026-10-20',holiday_name:'Company Festival',description:'Paid company holiday'};
    assert.equal((await run('get','/',4)).code,403);assert.equal((await run('get','/',5)).code,403);
    assert.equal((await run('get','/sites',2)).body.data.length,3);
    assert.equal((await run('post','/',2,holiday)).code,403);
    assert.equal((await run('get','/sites',3)).body.data.length,2,'City restriction applies to site catalog');
    assert.equal((await run('get','/sites',6)).body.data.length,1,'Site restriction narrows city access');
    assert.equal((await run('post','/',3,{...holiday,site_ids:[1,3]})).code,403);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM professional_holidays')).rows[0].n,0,'Out-of-scope batches must be atomic');
    assert.equal((await run('post','/',6,{...holiday,site_ids:[2]})).code,403);
    const created=await run('post','/',3,holiday);assert.equal(created.code,201);assert.equal(created.body.data.length,2);
    const logs=await db.query('SELECT * FROM professional_holiday_logs');assert.equal(logs.rows.length,2);assert.equal(logs.rows[0].actor_name,'Writer');
    assert.equal((await run('get','/',3,{}, {month:'2026-10',site:'1'})).body.data.length,1);
    assert.equal((await run('get','/',3,{}, {site:'3'})).code,403);
    assert.equal((await run('post','/',3,holiday)).code,409);
    assert.equal((await run('post','/',3,{...holiday,holiday_date:'2026-02-30'})).code,400);
    assert.equal((await run('post','/',3,{...holiday,site_ids:[1,1]})).code,400);
    const first=created.body.data[0];assert.equal((await run('delete','/:id',2,{}, {},{id:first.id})).code,403);
    assert.equal((await run('delete','/:id',3,{}, {},{id:first.id})).code,200);
    const history=await run('get','/history',3);assert.equal(history.body.data.length,3);assert.ok(history.body.data.some(l=>l.action==='deleted'&&l.holiday_id===first.id));
    failAudit=true;assert.equal((await run('post','/',3,{...holiday,holiday_date:'2026-10-21'})).code,500);failAudit=false;
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM professional_holidays WHERE holiday_date='2026-10-21'")).rows[0].n,0,'Audit failure rolls back declaration');
    const remaining=created.body.data[1];failAudit=true;assert.equal((await run('delete','/:id',3,{}, {},{id:remaining.id})).code,500);failAudit=false;
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM professional_holidays WHERE id=$1',[remaining.id])).rows[0].n,1,'Audit failure prevents deletion');
    await db.query("UPDATE users SET permissions='{}'::jsonb WHERE user_id=3");
    assert.equal((await run('get','/',3)).code,403,'Permission revocation is read from DB');
    console.log('PASS: holiday View/Write/No Access, city/site isolation, batch declarations, persistent actor history, duplicate/invalid input, atomic audit rollback and revocation.');
  }finally{await db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
