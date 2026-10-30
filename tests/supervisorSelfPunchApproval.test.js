const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const { resolveProfessionalLocation } = require('../utils/professionalLocation');
const { ensureProfessionalDesignation } = require('../utils/professionalDesignation');

test('Self-punch approval handles legacy and canonical location mappings without foreign key violations', async (t) => {
  const db = new PGlite();

  await db.exec(`
    CREATE TABLE cities (city_id INT PRIMARY KEY, city_name TEXT);
    CREATE TABLE zones (zone_id INT PRIMARY KEY, city_id INT, zone_name TEXT);
    CREATE TABLE sectors (sector_id INT PRIMARY KEY, zone_id INT, sector_name TEXT);
    CREATE TABLE wards (ward_id INT PRIMARY KEY, sector_id INT, zone_id INT, ward_name TEXT);
    CREATE TABLE department (department_id SERIAL PRIMARY KEY, department_name TEXT);
    CREATE TABLE designation (designation_id SERIAL PRIMARY KEY, designation_name TEXT, department_id INT);
    CREATE TABLE users (user_id INT PRIMARY KEY, name TEXT, email TEXT, role TEXT);

    CREATE TYPE self_punch_actor_type AS ENUM ('supervisor', 'admin');
    CREATE TYPE self_punch_action AS ENUM ('submitted', 'approved', 'rejected', 'viewed');

    CREATE TABLE self_punch_requests (
      id UUID PRIMARY KEY,
      full_name TEXT,
      mobile TEXT,
      email TEXT,
      aadhar_number TEXT,
      aadhar_doc_url TEXT,
      selfie_url TEXT,
      city_id INT REFERENCES cities(city_id),
      zone_id INT REFERENCES zones(zone_id),
      ward_id INT REFERENCES sectors(sector_id),
      kothi_id INT REFERENCES wards(ward_id),
      emp_code TEXT,
      status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE professional_employees (
      id UUID PRIMARY KEY,
      request_id UUID REFERENCES self_punch_requests(id),
      full_name TEXT,
      mobile TEXT,
      email TEXT,
      emp_code TEXT,
      password_hash TEXT,
      aadhar_number TEXT,
      aadhar_doc_url TEXT,
      selfie_url TEXT,
      city_id INT REFERENCES cities(city_id),
      zone_id INT REFERENCES zones(zone_id),
      ward_id INT REFERENCES sectors(sector_id),
      kothi_id INT REFERENCES wards(ward_id),
      face_locked BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE employee (
      emp_id SERIAL PRIMARY KEY,
      emp_code TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      ward_id INT NOT NULL REFERENCES wards(ward_id),
      designation_id INT NOT NULL REFERENCES designation(designation_id),
      aadhar_no TEXT,
      aadhar_url TEXT,
      face_embedding TEXT,
      self_attendance_enabled BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE professional_week_off (
      professional_id UUID PRIMARY KEY,
      week_off_days INT[],
      created_by INT,
      updated_by INT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE professional_leave_allocations (
      professional_id UUID,
      leave_type TEXT,
      period TEXT,
      allocated_count INT,
      created_by INT,
      updated_by INT,
      PRIMARY KEY (professional_id, leave_type, period)
    );

    CREATE TABLE professional_leave_allocation_logs (
      id SERIAL PRIMARY KEY,
      professional_id UUID,
      actor_user_id INT,
      actor_name TEXT,
      change_summary TEXT,
      old_values TEXT,
      new_values TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE self_punch_request_logs (
      id SERIAL PRIMARY KEY,
      request_id UUID REFERENCES self_punch_requests(id),
      action self_punch_action,
      performed_by_type self_punch_actor_type,
      performed_by_id INT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    INSERT INTO cities VALUES (1, 'Indore');
    INSERT INTO zones VALUES (114, 1, 'Indore Municipal Corporation');
    INSERT INTO sectors VALUES (145, 114, 'IMC ZONE 08');
    INSERT INTO wards VALUES (1590, 145, 114, '37');
    INSERT INTO users VALUES (4, 'Admin', 'admin@matrixtrack.in', 'admin');
  `);

  await t.test('approves legacy request (ward_id=1590, kothi_id=1590) with resolved canonical references', async () => {
    const requestId = '2292f9ea-0ec5-4a1e-8b9d-e49a1a1507d4';

    // In legacy requests, ward_id was set to 1590. Drop constraint temporarily to insert legacy row as in production
    await db.exec(`
      ALTER TABLE self_punch_requests DROP CONSTRAINT self_punch_requests_ward_id_fkey;
      INSERT INTO self_punch_requests (id, full_name, mobile, email, aadhar_number, city_id, zone_id, ward_id, kothi_id, emp_code, status)
      VALUES ('${requestId}', 'Amar Bahar', '9770445177', 'amar@example.com', '123412341234', 1, 114, 1590, 1590, '000000', 'pending');
      ALTER TABLE self_punch_requests ADD CONSTRAINT self_punch_requests_ward_id_fkey FOREIGN KEY (ward_id) REFERENCES sectors(sector_id) NOT VALID;
    `);

    // Run resolution
    const loc = await resolveProfessionalLocation(db, {
      city_id: 1,
      zone_id: 114,
      ward_id: 1590,
      kothi_id: 1590
    });

    assert.equal(loc.ward_id, 145);
    assert.equal(loc.kothi_id, 1590);
    assert.equal(loc.employee_ward_id, 1590);

    // Perform approval workflow
    await db.query('BEGIN');

    // 1. Update self_punch_requests
    await db.query(`
      UPDATE self_punch_requests
      SET status = 'approved',
          ward_id = $1,
          kothi_id = $2,
          zone_id = COALESCE($3, zone_id),
          city_id = COALESCE($4, city_id),
          updated_at = NOW()
      WHERE id = $5
    `, [loc.ward_id, loc.kothi_id, loc.zone_id, loc.city_id, requestId]);

    // 2. Insert into professional_employees
    const passwordHash = await bcrypt.hash('amar@5177', 10);
    await db.query(`
      INSERT INTO professional_employees (
        id, request_id, full_name, mobile, email, emp_code, password_hash,
        city_id, zone_id, ward_id, kothi_id, face_locked, is_active
      ) VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, true)
    `, [requestId, 'Amar Bahar', '9770445177', 'amar@example.com', '000000', passwordHash,
        loc.city_id, loc.zone_id, loc.ward_id, loc.kothi_id]);

    // 3. Week off
    await db.query(`
      INSERT INTO professional_week_off (professional_id, week_off_days, created_by, updated_by)
      VALUES ($1, $2, $3, $3)
    `, [requestId, [0], 4]);

    // 4. Employee master sync
    const { designationId } = await ensureProfessionalDesignation(db);
    await db.query(`
      INSERT INTO employee (emp_code, name, phone, ward_id, designation_id, aadhar_no, self_attendance_enabled)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      ON CONFLICT (emp_code) DO UPDATE SET
        name = EXCLUDED.name,
        ward_id = EXCLUDED.ward_id
    `, ['000000', 'Amar Bahar', '9770445177', loc.employee_ward_id, designationId, '123412341234']);

    // 5. Audit log
    await db.query(`
      INSERT INTO self_punch_request_logs (request_id, action, performed_by_type, performed_by_id, note)
      VALUES ($1, 'approved', 'admin', $2, 'Approved by Admin')
    `, [requestId, 4]);

    await db.query('COMMIT');

    // Verify database state
    const peRow = (await db.query('SELECT * FROM professional_employees WHERE id = $1', [requestId])).rows[0];
    assert.equal(peRow.ward_id, 145);
    assert.equal(peRow.kothi_id, 1590);
    assert.equal(peRow.is_active, true);

    const sprRow = (await db.query('SELECT * FROM self_punch_requests WHERE id = $1', [requestId])).rows[0];
    assert.equal(sprRow.status, 'approved');
    assert.equal(sprRow.ward_id, 145);
    assert.equal(sprRow.kothi_id, 1590);

    const empRow = (await db.query('SELECT * FROM employee WHERE emp_code = $1', ['000000'])).rows[0];
    assert.equal(empRow.ward_id, 1590);
    assert.equal(empRow.self_attendance_enabled, true);

    const logRow = (await db.query('SELECT * FROM self_punch_request_logs WHERE request_id = $1', [requestId])).rows[0];
    assert.equal(logRow.action, 'approved');
    assert.equal(logRow.performed_by_type, 'admin');
  });
});
