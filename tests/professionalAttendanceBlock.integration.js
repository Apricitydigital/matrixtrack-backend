// Isolated PostgreSQL integration checks. No production database, AWS or photos.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
const identity = require('../utils/professionalAttendanceIdentity');
const groups = require('../config/professionalAttendanceIdentities');
const load = (file, deps) => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    module, require: name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; },
    __dirname: path.dirname(path.join(__dirname, file)), console, Buffer, Map, Set, Date, Promise,
    process: { env: { PROFESSIONAL_LIVENESS_ENABLED: 'false' } },
  });
  return module.exports;
};
const response = () => ({ code: 200, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
async function main() {
  const db = new PGlite();
  let queryLog;
  const query = async (sql, params = []) => {
    if (queryLog) queryLog.push(sql);
    return params.length ? db.query(sql, params) : (await db.exec(sql)).at(-1) || { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const person = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
  const { primaryId, profileIds } = groups[0];
  try {
    await query(`CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,email TEXT,role TEXT,permissions JSONB,is_deleted BOOLEAN DEFAULT FALSE);
      CREATE TABLE permissions(id SERIAL PRIMARY KEY,module TEXT,action TEXT);
      CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);
      CREATE TABLE zones(zone_id INT PRIMARY KEY,zone_name TEXT);
      CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT);
      CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,mobile TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,is_active BOOLEAN DEFAULT TRUE,selfie_url TEXT);
      CREATE TABLE professional_attendance(id SERIAL PRIMARY KEY,professional_id UUID,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,attempted_punch_in TIMESTAMPTZ,punch_approval_status TEXT DEFAULT 'accepted',punch_cutoff TIME,ward_id INT,zone_id INT,city_id INT,UNIQUE(professional_id,date));
      CREATE TABLE professional_punch_cutoffs(professional_id UUID,cutoff_time TIME);
      CREATE TABLE professional_punch_settings(id INT,enabled BOOLEAN);
      CREATE TABLE professional_leave_requests(professional_id UUID,requested_date DATE,status TEXT,leave_type TEXT);
      CREATE TABLE professional_holidays(id SERIAL,holiday_name TEXT,description TEXT,holiday_date DATE,city_id INT,zone_id INT,ward_id INT,kothi_id INT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE FUNCTION professional_is_week_off(UUID,DATE) RETURNS BOOLEAN LANGUAGE SQL AS 'SELECT FALSE';
      INSERT INTO professional_punch_settings VALUES(1,FALSE);
      INSERT INTO cities VALUES(1,'Indore'),(2,'Outside');
      INSERT INTO zones VALUES(1,'Zone'); INSERT INTO wards VALUES(1,'Site');
      INSERT INTO users VALUES
        (1,'Owner','admin@gmail.com','admin','{}',FALSE),
        (2,'Writer','writer@example.test','admin','{"assigned_cities":[1],"modules":{"professional_employee_block":"write"}}',FALSE),
        (3,'Reader','reader@example.test','admin','{"assigned_cities":[1],"modules":{"professional_employee_block":"view"}}',FALSE),
        (4,'Denied','denied@example.test','admin','{"modules":{}}',FALSE),
        (5,'Inactive','inactive@example.test','admin','{"is_active":false,"modules":{"professional_employee_block":"write"}}',FALSE),
        (6,'Supervisor','supervisor@example.test','supervisor',NULL,FALSE),
        (7,'Deleted','deleted@example.test','super_admin',NULL,TRUE),
        (8,'Super role','super@example.test','super_admin',NULL,FALSE),
        (9,'Legacy admin','legacy@example.test','admin',NULL,FALSE);
      INSERT INTO professional_employees(id,full_name,emp_code,mobile,city_id,zone_id,ward_id,kothi_id,selfie_url)
        VALUES('${person}','Asha','E001','9000000001',1,1,1,1,'photo'),('${other}','Outside','E002','9000000002',2,1,1,1,'photo');`);
    for (const id of profileIds) await query(`INSERT INTO professional_employees(id,full_name,emp_code,mobile,city_id,zone_id,ward_id,kothi_id,selfie_url)
      VALUES($1,'Manisha',$2,'9000000003',1,1,1,1,'photo')`, [id, id.slice(0,8)]);
    const blocks = load('../utils/professionalAttendanceBlock.js', { fs, path, '../config/db': pool, './professionalAttendanceIdentity': identity });
    await Promise.all(Array.from({ length: 5 }, () => blocks.ensureAttendanceBlockSchema()));
    const before = await query('SELECT COUNT(*)::int AS n FROM professional_attendance_blocks');
    assert.equal(before.rows[0].n, 0, 'migration does not block anyone by default');
    await query(fs.readFileSync(path.join(__dirname, '../db/migrations/20261021_professional_attendance_blocks.sql'), 'utf8'));
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM permissions')).rows[0].n, 2, 'migration is repeatable');
    const cityAccess = async user => {
      const p = (await query('SELECT permissions FROM users WHERE user_id=$1', [user.user_id])).rows[0]?.permissions;
      return p?.assigned_cities?.length ? { all: false, ids: p.assigned_cities } : { all: true, ids: [] };
    };
    const permissions = load('../middleware/permissionMiddleware.js', { '../config/db': pool, '../utils/userCityAccess': { fetchUserCityAccess: cityAccess, invalidateCityAccessCache() {} } });
    const router = { routes: [], middleware: [], use(...handlers) { this.middleware.push(...handlers); } };
    for (const method of ['get', 'patch']) router[method] = (url, ...handlers) => router.routes.push({ method, url, handlers });
    load('../routes/professionalEmployeeBlockRoutes.js', {
      express: { Router: () => router }, '../config/db': pool, '../middleware/authMiddleware': (req, res, next) => next(),
      '../middleware/cityScope': { attachCityScope: async (req, res, next) => { req.cityScope = await cityAccess(req.user); next(); } },
      '../middleware/permissionMiddleware': permissions, '../utils/professionalAttendanceIdentity': identity, '../utils/professionalAttendanceBlock': blocks,
    });
    const run = async (method, url, user, options = {}) => {
      // Forged JWT claims must never override the user's current DB rights.
      const req = { user: { user_id: user, role: 'super_admin' }, query: {}, params: { id: person }, body: {}, ...options };
      const res = response();
      for (const handler of [...router.middleware, ...router.routes.find(r => r.method === method && r.url === url).handlers]) {
        if (handler.length < 3) await handler(req, res);
        else { let next = false; await handler(req, res, () => { next = true; }); if (!next) break; }
      }
      return res;
    };
    const change = (user, id, blocked, expected = !blocked, reason = 'Verified by operations') => run('patch', '/:id', user, { params: { id }, body: { is_blocked: blocked, expected_blocked: expected, reason } });
    for (const user of [4,5,6,7]) assert.equal((await run('get', '/', user)).code, 403, `user ${user} cannot open directory`);
    assert.equal((await change(3, person, true)).code, 403, 'view does not grant write');
    assert.equal((await run('get', '/', 3)).body.data.some(p => p.id === other), false, 'city scope filters directory');
    assert.equal((await change(2, other, true)).code, 404, 'cannot block across cities by calling API');
    assert.equal((await run('get', '/:id/history', 2, { params: { id: other } })).code, 404);
    assert.equal((await change(2, 'bad', true)).code, 400);
    assert.equal((await change(2, person, true, false, ' ')).code, 400);
    assert.equal((await change(2, person, true, true)).code, 409, 'stale state cannot overwrite another admin');
    assert.equal((await change(2, person, true)).code, 200);
    assert.equal((await change(2, person, true)).code, 409, 'duplicate action creates no audit entry');
    assert.equal((await blocks.getAttendanceBlock(person)).is_attendance_blocked, true);
    assert.equal((await blocks.getAttendanceBlock(other)).is_attendance_blocked, false);
    let wrote = false;
    await assert.rejects(blocks.withUnblockedAttendance(person, async () => { wrote = true; }), error => error.code === 'ATTENDANCE_BLOCKED');
    assert.equal(wrote, false, 'integration guard rejects before executing a write');
    assert.equal((await run('get', '/:id/history', 3)).body.data[0].actor_name, 'Writer');
    assert.equal((await run('get', '/', 3, { query: { status: 'blocked', search: 'Asha' } })).body.data.length, 1);
    assert.equal((await change(8, person, false)).code, 200, 'superadmin role can unblock');
    assert.equal((await change(9, person, true)).code, 200, 'legacy unrestricted admin matches existing RBAC');
    assert.equal((await change(1, person, false)).code, 200, 'owner can unblock');
    assert.equal((await change(2, profileIds[1], true)).code, 200, 'block through a reviewed alias');
    for (const id of profileIds) assert.equal((await blocks.getAttendanceBlock(id)).is_attendance_blocked, true);
    assert.equal((await run('get', '/:id/history', 2, { params: { id: primaryId } })).body.data.length, 1, 'all aliases share the action history');
    await query('UPDATE professional_employees SET city_id=2 WHERE id=$1', [profileIds[2]]);
    assert.equal((await change(2, primaryId, false)).code, 403, 'linked cities are checked before any mutation');
    for (const id of profileIds) assert.equal((await blocks.getAttendanceBlock(id)).is_attendance_blocked, true);
    await query('UPDATE professional_employees SET city_id=1 WHERE id=$1', [profileIds[2]]);
    assert.equal((await change(2, primaryId, false)).code, 200);
    // Permission revocation is read from the DB even with an existing token.
    await query(`UPDATE users SET permissions='{"modules":{"professional_employee_block":"view"}}' WHERE user_id=2`);
    assert.equal((await change(2, person, true)).code, 403);
    await query(`UPDATE users SET permissions='{"assigned_cities":[1],"modules":{"professional_employee_block":"write"}}' WHERE user_id=2`);

    let faceCalls = 0, afterFace;
    const controller = load('../controllers/professionalAttendanceController.js', {
      '../config/db': pool, '../utils/professionalAttendanceIdentity': identity, '../utils/professionalAttendanceBlock': blocks,
      '../utils/professionalPunchCutoff': { ensurePunchCutoffSchema: async () => {}, getPunchSettings: async () => ({ enabled: false }), loadPunchApprovals: async () => new Map(), approvalProgress: () => null },
      '../utils/logger': { info() {}, warn() {}, error: console.error }, '../utils/faceService': { verifyFaceMatch: async () => { faceCalls++; if (afterFace) await afterFace(); return { isMatch: true }; } },
      '../config/awsConfig': {}, '../utils/s3SelfPunch': { uploadToS3: async () => null }, '../utils/professionalLeaveSchema': { ensureProfessionalLeaveSchema: async () => {} },
      '../utils/cityTrafficCost': { trackSuccessfulAttendanceEvent() {} }, './professionalGeofenceController': { validateProfessionalGeofenceAccess: async () => ({ allowed: true }) }, './consentController': { logUserConsent: async () => {} },
    });
    const punch = async (method, id = person) => {
      const res = response();
      await controller[method]({ professional: { professional_id: id, ward_id: 1, city_id: 1, zone_id: 1 }, body: { selfie_base64: 'eA==' }, headers: {} }, res);
      return res;
    };
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    queryLog = [];
    assert.equal((await punch('punchIn')).code, 200, 'normal punch-in still works');
    const accessReads = queryLog.filter(sql => /FROM\s+professional_employees|FROM\s+professional_attendance_blocks/i.test(sql));
    assert.equal(accessReads.length, 2, 'profile, block and cutoff checks fit the original two DB round trips');
    assert.equal(queryLog.some(sql => /CREATE TABLE/i.test(sql)), false, 'warm punches never repeat block schema DDL');
    queryLog = null;
    const integrations = load('../controllers/externalApiController.js', { '../config/db': pool, '../utils/professionalAttendanceBlock': blocks });
    const snapshot = (await query('SELECT * FROM professional_attendance ORDER BY id')).rows;
    assert.equal((await change(2, person, true)).code, 200);
    assert.deepEqual((await query('SELECT * FROM professional_attendance ORDER BY id')).rows, snapshot, 'blocking never rewrites punches');
    const faces = faceCalls;
    for (const method of ['punchIn','punchOut']) {
      const res = await punch(method);
      assert.equal(res.code, 403); assert.equal(res.body.code, 'ATTENDANCE_BLOCKED');
    }
    assert.equal(faceCalls, faces, 'blocked requests stop before biometrics');
    for (const method of ['markProfessionalPunchIn','markProfessionalPunchOut']) {
      const res = response();
      await integrations[method]({ body: { professional_id: person }, apiKey: { cityId: 1 } }, res);
      assert.equal(res.code, 403); assert.equal(res.body.error.code, 'ATTENDANCE_BLOCKED', 'integrations cannot bypass access restrictions');
    }
    for (const [method, expected] of [['markProfessionalPunchIn',201],['markProfessionalPunchOut',200]]) {
      const res = response();
      await integrations[method]({ body: { professional_id: other }, apiKey: { cityId: 2 } }, res);
      assert.equal(res.code, expected, 'unrelated employees can still punch through integrations');
    }
    const statusRes = response();
    await controller.getTodayStatus({ professional: { professional_id: person } }, statusRes);
    assert.equal(statusRes.body.data.status, 'blocked'); assert.ok(statusRes.body.data.punch_in, 'today retains existing punch time');
    const decorated = await blocks.withAttendanceBlocks([{ professional_id: person, attendance_count: 28, payable_days: 29 }, { professional_id: other, payable_days: 20 }]);
    assert.equal(decorated[0].is_attendance_blocked, true); assert.equal(decorated[0].attendance_count, 28); assert.equal(decorated[0].payable_days, 29);
    assert.equal(decorated[1].is_attendance_blocked, undefined); assert.equal(decorated[1].payable_days, 20);
    assert.equal((await change(2, person, false)).code, 200);
    // Admin commits a block while punch-out is verifying a face. The final write
    // must see that committed block even though the first check passed.
    afterFace = async () => { afterFace = null; assert.equal((await change(2, person, true)).code, 200); };
    const raced = await punch('punchOut');
    assert.equal(raced.body.code, 'ATTENDANCE_BLOCKED');
    assert.equal((await query('SELECT punch_out FROM professional_attendance WHERE professional_id=$1 AND date=$2', [person, today])).rows[0].punch_out, null);
    assert.equal((await change(2, person, false)).code, 200);
    assert.equal((await punch('punchOut')).code, 200, 'unblock restores normal punch-out');
    assert.equal((await change(2, primaryId, true)).code, 200);
    for (const id of profileIds) {
      assert.equal((await punch('punchIn', id)).body.code, 'ATTENDANCE_BLOCKED');
      assert.equal((await punch('punchOut', id)).body.code, 'ATTENDANCE_BLOCKED');
    }
    assert.ok((await query('SELECT punch_out FROM professional_attendance WHERE professional_id=$1', [person])).rows[0].punch_out);
    console.log('PASS: two profile/access DB reads (no added punch-in round trips), block/unblock, RBAC, city isolation, audit, aliases, stale state, unchanged history/payable days, normal punches and a block committed during face verification.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
