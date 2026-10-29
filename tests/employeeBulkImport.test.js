const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {PGlite} = require('@electric-sql/pglite');
const {importOptions,validateImport,insertImport} = require('../utils/employeeBulkImport');

const input = (changes={}) => ({row_number:2,name:'New employee',emp_code:'NEW-01',aadhar_no:'123456789012',phone:'9876543210',no_personal_phone:'No',city:'City A',zone:'Zone A',ward:'Ward A',kothi:'Site A',department:'Operations',designation:'Operator',...changes});
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE cities(city_id int PRIMARY KEY,city_name text);
    CREATE TABLE zones(zone_id int PRIMARY KEY,zone_name text,city_id int REFERENCES cities);
    CREATE TABLE sectors(sector_id int PRIMARY KEY,sector_name text,zone_id int REFERENCES zones);
    CREATE TABLE wards(ward_id int PRIMARY KEY,ward_name text,sector_id int REFERENCES sectors,zone_id int REFERENCES zones);
    CREATE TABLE department(department_id int PRIMARY KEY,department_name text);
    CREATE TABLE designation(designation_id int PRIMARY KEY,designation_name text,department_id int REFERENCES department);
    CREATE TABLE employee(emp_id serial PRIMARY KEY,emp_code varchar(50) UNIQUE,name varchar(100),phone text,ward_id int REFERENCES wards,
      designation_id int REFERENCES designation,aadhar_no text,no_personal_phone boolean DEFAULT false);
    CREATE TABLE professional_employees(emp_code text,mobile text);
    CREATE TABLE self_punch_requests(emp_code text,mobile text,status text);
    INSERT INTO cities VALUES(1,'City A'),(2,'City B');
    INSERT INTO zones VALUES(10,'Zone A',1),(20,'Zone B',2);
    INSERT INTO sectors VALUES(100,'Ward A',10),(200,'Ward B',20);
    INSERT INTO wards VALUES(1000,'Site A',100,10),(2000,'Site B',200,20);
    INSERT INTO department VALUES(7,'Operations'),(8,'Other department');
    INSERT INTO designation VALUES(70,'Operator',7),(80,'Other role',8);
    INSERT INTO employee(emp_code,name,phone,ward_id,designation_id,aadhar_no) VALUES('EXISTING','Existing','9999999999',1000,70,'999999999999');
    INSERT INTO professional_employees VALUES('PRO-01','8888888888');
    INSERT INTO self_punch_requests VALUES('PENDING-01','7777777777','pending');`);
  return db;
}

test('validates names and IDs within location scope and preserves no-phone employees',async()=>{
  const db=await fixture();
  try {
    const options=await importOptions(db,[1],[1000]);
    assert.equal(options.locations.length,1);
    let result=await validateImport(db,[input()],options,[1],[1000]);
    assert.equal(result.can_import,true);assert.equal(result.rows[0].kothi_id,1000);
    result=await validateImport(db,[input({city:1,zone:10,ward:100,kothi:1000,department:7,designation:70,phone:'',no_personal_phone:'Yes'})],options,[1],[1000]);
    assert.equal(result.can_import,true);assert.equal(result.rows[0].phone,null);assert.equal(result.rows[0].no_personal_phone,true);
    result=await validateImport(db,[input({phone:'+91 98765 43210'})],options,[1],[1000]);
    assert.equal(result.rows[0].phone,'9876543210');assert.equal(result.can_import,true);
    for (const changes of [{zone:'Zone B'},{department:'Other department'},{phone:'123'},{aadhar_no:'123'},{no_personal_phone:'Yes'},{name:''},{name:'N'.repeat(101)}]) {
      result=await validateImport(db,[input(changes)],options,[1],[1000]);assert.equal(result.can_import,false,JSON.stringify(changes));
    }
    result=await validateImport(db,[input({name:'N'.repeat(100)})],options,[1],[1000]);assert.equal(result.can_import,true);
    result=await validateImport(db,[input()],options,[2],[1000]);assert.match(result.errors[0].message,/outside your access/);
    assert.equal((await importOptions(db,[],[])).locations.length,0);
    await assert.rejects(validateImport(db,[],options),{status:400});
    await assert.rejects(validateImport(db,Array(501).fill(input()),options),{status:400});
  } finally {await db.close();}
});

test('rejects duplicates in file, Employee Master and professional accounts without writes',async()=>{
  const db=await fixture();
  try {
    const options=await importOptions(db,null,null);
    let result=await validateImport(db,[input(),input({row_number:3,emp_code:'new-01'})],options,null,null);
    assert.equal(result.invalid,2);assert.equal(result.can_import,false);
    for (const changes of [{emp_code:'existing'},{phone:'9999999999'},{aadhar_no:'999999999999'},{emp_code:'PRO-01'},{phone:'8888888888'},{emp_code:'PENDING-01'}]) {
      result=await validateImport(db,[input(changes)],options,null,null);
      assert.equal(result.can_import,false);assert.ok(result.errors.some(error=>error.message.includes('already registered')));
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM employee')).rows[0].n,1);
    await assert.rejects(validateImport(db,[input(),input()],options,null,null),{status:400});
  } finally {await db.close();}
});

function loadController(db) {
  const commands=[];
  const client={query:async(sql,params)=>{
    commands.push(sql);
    if(sql.startsWith('LOCK TABLE'))return {rows:[]}; // PGlite is single connection.
    return db.query(sql,params);
  },release:()=>commands.push('RELEASE')};
  const module={exports:{}};
  const file=path.join(__dirname,'../controllers/employeeBulkImportController.js');
  vm.runInNewContext('(function(require,module){'+fs.readFileSync(file,'utf8')+'})',{console:{error:()=>{}}})(name=>{
    if(name==='../config/db')return {connect:async()=>client};
    if(name==='../middleware/permissionMiddleware')return {getPermissionCityFilter:()=>null};
    if(name==='../utils/employeeBulkImport')return {importOptions,validateImport,insertImport};
    throw new Error(name);
  },module);
  return {controller:module.exports,commands};
}
const response=()=>({code:200,status(code){this.code=code;return this;},json(data){this.data=data;return this;}});
test('controller previews without saving, revalidates on apply and inserts an entire batch atomically',async()=>{
  const db=await fixture();
  try {
    const {controller,commands}=loadController(db);
    const call=async(rows,preview)=>{const res=response();await controller.importEmployees({body:{rows,preview},kothiScope:{all:true}},res);return res;};
    let result=await call([input()],true);
    assert.equal(result.code,200);assert.equal(result.data.can_import,true);assert.equal(result.data.imported,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM employee')).rows[0].n,1);
    assert.ok(commands.includes('BEGIN READ ONLY'));assert.ok(commands.includes('ROLLBACK'));
    await db.query("INSERT INTO employee(emp_code) VALUES('NEW-01')");
    result=await call([input()],false);assert.equal(result.code,400);assert.equal(result.data.imported,0);
    const batch=[input({emp_code:'NEW-02'}),input({row_number:3,emp_code:'NEW-03',phone:'',no_personal_phone:'Yes',aadhar_no:''})];
    result=await call(batch,false);assert.equal(result.code,201);assert.equal(result.data.imported,2);
    const created=(await db.query("SELECT * FROM employee WHERE emp_code IN ('NEW-02','NEW-03') ORDER BY emp_code")).rows;
    assert.equal(created[0].ward_id,1000);assert.equal(created[0].designation_id,70);assert.equal(created[1].phone,null);assert.equal(created[1].no_personal_phone,true);
    result=await call(batch,false);assert.equal(result.code,400); // Repeated clicks never duplicate.
    assert.equal((await db.query('SELECT count(*)::int AS n FROM employee')).rows[0].n,4);
    await db.exec(`ALTER TABLE employee ADD CONSTRAINT simulated_failure CHECK(emp_code <> 'FAIL');`);
    result=await call([input({emp_code:'VALID',phone:'6666666666',aadhar_no:''}),input({row_number:3,emp_code:'FAIL',phone:'5555555555',aadhar_no:''})],false);
    assert.equal(result.code,500);assert.equal((await db.query("SELECT count(*)::int AS n FROM employee WHERE emp_code='VALID'")).rows[0].n,0);
    assert.equal(commands.at(-1),'RELEASE');
  } finally {await db.close();}
});
