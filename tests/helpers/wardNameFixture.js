'use strict';
const {PGlite}=require('@electric-sql/pglite');
const person='10000000-0000-4000-8000-000000000001';
const adapter=db=>({query:async(sql,params=[])=>params.length?db.query(sql,params):(await db.exec(sql)).at(-1)||{rows:[]}});
async function fixture(){const db=new PGlite();await db.exec(`
 CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);INSERT INTO cities VALUES(1,'City');
 CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT,zone_name TEXT);INSERT INTO zones VALUES(55,1,'Zone A'),(129,1,'Zone B');
 CREATE TABLE sectors(sector_id INT PRIMARY KEY,zone_id INT,sector_name VARCHAR(100));
 INSERT INTO sectors VALUES(10,55,'Human Matrix'),(20,129,'IT Campus'),(30,55,'Campus'),(31,55,'Same');
 CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT NOT NULL,sector_id INT,ward_name VARCHAR(100) NOT NULL,UNIQUE(ward_name,zone_id));
 INSERT INTO wards VALUES(1008,55,10,'Solaris'),(1010,55,10,'Head Office'),(1569,129,20,'Crystal It Park'),
 (1621,55,NULL,'QA Site'),(1900,55,30,'Campus + Store'),(1901,55,31,'Same');
 CREATE VIEW attendance_dashboard_view AS SELECT s.sector_id AS ward_id,s.sector_name AS ward_name,
 w.ward_id AS kothi_id,w.ward_name AS kothi_name FROM wards w LEFT JOIN sectors s ON w.sector_id=s.sector_id LEFT JOIN zones z ON w.zone_id=z.zone_id;
 CREATE TABLE department(department_id INT PRIMARY KEY,department_name TEXT);INSERT INTO department VALUES(1,'Operations');
 CREATE TABLE designation(designation_id INT PRIMARY KEY,department_id INT,designation_name TEXT);INSERT INTO designation VALUES(1,1,'Sweeper');
 CREATE TABLE employee(emp_id INT PRIMARY KEY,emp_code TEXT,name TEXT,ward_id INT,phone TEXT,aadhar_no TEXT,face_embedding TEXT);
 INSERT INTO employee VALUES(7,'OLD','Worker',1008,'9000000000',NULL,'original-face');
 CREATE TABLE attendance(attendance_id INT PRIMARY KEY,emp_id INT,ward_id INT,date DATE,punch_in_time TIMESTAMPTZ,punch_out_time TIMESTAMPTZ,status TEXT,photo TEXT);
 INSERT INTO attendance VALUES(1,7,1008,'2026-10-31','2026-10-31T03:30:00Z',NULL,'present','original-photo');
 CREATE TABLE self_punch_requests(id UUID PRIMARY KEY,status TEXT,emp_code TEXT,mobile TEXT,city_id INT,zone_id INT,ward_id INT NOT NULL,kothi_id INT);
 INSERT INTO self_punch_requests VALUES('${person}','approved','SELF','9111111111',1,55,10,1008);
 CREATE TABLE self_attendance_employees AS SELECT *,id AS request_id,TRUE AS is_active,'same-password'::text AS password_hash FROM self_punch_requests;
 ALTER TABLE self_attendance_employees ALTER COLUMN ward_id SET NOT NULL;
 CREATE TABLE self_attendance_records(id INT PRIMARY KEY,self_attendance_id UUID,date DATE,ward_id INT NOT NULL,kothi_id INT,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,photo TEXT);
 INSERT INTO self_attendance_records VALUES(1,'${person}','2026-10-31',10,NULL,'2026-10-31T03:30:00Z',NULL,'old-photo');
 CREATE TABLE users(user_id INT,role TEXT);INSERT INTO users VALUES(9,'supervisor');
 CREATE TABLE supervisor_ward(supervisor_id INT,ward_id INT);INSERT INTO supervisor_ward VALUES(9,1008);
 CREATE TABLE supervisor_kothi(supervisor_id INT,ward_id INT);
 CREATE TABLE user_city_access(user_id INT,city_id INT);CREATE TABLE user_zone_access(user_id INT,zone_id INT);
 CREATE TABLE user_kothi_access(user_id INT,ward_id INT);
 `);return db;}
async function protectedRows(db){const result={};for(const name of ['employee','attendance','self_attendance_employees','self_punch_requests','self_attendance_records','supervisor_ward'])result[name]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${name} t`)).rows;return result;}
module.exports={fixture,adapter,protectedRows};
