const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');

test('overlapping sector and ward IDs return one request, consistent paging and working searches', async () => {
  const db = new PGlite();
  const load = file => {
    const module = { exports: {} };
    const dependencies = {
      '../config/db': db,
      '../utils/logger': { error() {}, warn() {}, info() {} },
      '../utils/s3SelfPunch': { getSignedS3Url: async x => x },
      '../utils/encryption': { decryptAadhar: x => x },
      '../utils/socket': {}, bcryptjs: {}, '../utils/smsNotifier': {},
      '../utils/professionalDesignation': {}, '../utils/professionalLocation': {},
      '../utils/professionalIdentity': require('../utils/professionalIdentity'),
      '../utils/professionalRequestFilters': require('../utils/professionalRequestFilters'),
      '../utils/professionalRequestLocation': require('../utils/professionalRequestLocation'),
      './supervisorSelfPunchController': controller,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers', file), 'utf8'), {
      module, require: name => dependencies[name], console,
    });
    return module.exports;
  };
  let controller;
  const run = async (handler, query = {}, user = { role: 'admin' }) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler({ query, user, supervisorId: 1 }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    return res.body;
  };
  try {
    await db.exec(`
      CREATE TABLE cities(city_id INT PRIMARY KEY, city_name TEXT);
      CREATE TABLE zones(zone_id INT PRIMARY KEY, city_id INT, zone_name TEXT);
      CREATE TABLE sectors(sector_id INT PRIMARY KEY, zone_id INT, sector_name TEXT);
      CREATE TABLE wards(ward_id INT PRIMARY KEY, sector_id INT, zone_id INT, ward_name TEXT);
      CREATE TABLE employee(emp_id INT, emp_code TEXT, designation_id INT);
      CREATE TABLE designation(designation_id INT, designation_name TEXT, department_id INT);
      CREATE TABLE department(department_id INT, department_name TEXT);
      CREATE TABLE self_punch_requests(id UUID PRIMARY KEY, full_name TEXT, mobile TEXT, email TEXT,
        emp_code TEXT, status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
        city_id INT, zone_id INT, ward_id INT, kothi_id INT, aadhar_number TEXT, selfie_url TEXT, aadhar_doc_url TEXT);
      CREATE TABLE professional_attendance(professional_id UUID, date DATE, punch_in TIMESTAMPTZ, punch_out TIMESTAMPTZ);
      INSERT INTO cities VALUES(1,'City');
      INSERT INTO zones VALUES(10,1,'Zone');
      INSERT INTO sectors VALUES(5,10,'Correct Ward'),(7,10,'Unrelated Ward');
      INSERT INTO wards VALUES(5,7,10,'Overlapping ID'),(100,5,10,'Head Office');
      INSERT INTO self_punch_requests VALUES
        ('11111111-1111-1111-1111-111111111111','Jay Test','+91 98765 43210','jay@example.com',
         'MP08976','approved',NOW(),NOW(),1,10,5,100,'123456789012',NULL,NULL),
        ('22222222-2222-2222-2222-222222222222','Legacy User','9876543211','legacy@example.com',
         'LEGACY','approved',NOW(),NOW(),1,10,100,100,'999999999999',NULL,NULL);
    `);
    controller = load('supervisorSelfPunchController.js');
    const approved = load('approvedProfessionalController.js');
    const all = await run(controller.getRequests, { status: 'approved' });
    assert.equal(all.data.length, 2);
    assert.equal(new Set(all.data.map(x => x.id)).size, 2);
    assert.equal(all.pagination.total, 2);
    assert.ok(all.data.every(x => x.ward_name === 'Correct Ward'));
    const first = await run(controller.getRequests, { status: 'approved', limit: 1, page: 1 });
    const second = await run(controller.getRequests, { status: 'approved', limit: 1, page: 2 });
    assert.notEqual(first.data[0].id, second.data[0].id);
    for (const filter of [
      { emp_code: 'mp089' }, { employee_name: 'jay' }, { mobile: '43210' },
      { mobile: '+91 98765 43210' }, { aadhar_number: '1234 5678 9012' },
      { city_id: '1', zone_id: '10', ward_id: '5', kothi_id: '100', employee_name: 'Jay' },
    ]) {
      const list = await run(controller.getRequests, { status: 'approved', ...filter });
      assert.equal(list.pagination.total, 1, JSON.stringify(filter));
      assert.equal(list.data[0].full_name, 'Jay Test');
      const exported = await run(approved.getApprovedList, filter);
      assert.equal(exported.data.length, 1);
      assert.equal(exported.data[0].id, list.data[0].id);
    }
    const ward = await run(controller.getRequests, { status: 'approved', ward_id: '5' });
    assert.equal(ward.data.length, 2, 'legacy ward references use the same canonical sector filter');
    const facets = await run(approved.getApprovedList, { facets: 'true' });
    assert.ok(facets.data.every(x => x.ward_id === 5 && x.ward_name === 'Correct Ward'));
    const none = await run(controller.getRequests, { status: 'approved', employee_name: 'Missing' });
    assert.equal(none.pagination.total, 0);
    assert.equal(none.data.length, 0);
  } finally { await db.close(); }
});
