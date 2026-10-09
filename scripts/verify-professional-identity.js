const assert = require('node:assert/strict');
const pool = require('../config/db');
const { decryptAadhar } = require('../utils/encryption');
const { findProfessionalIdentityConflict, hasAadhaarRequestAtWard } = require('../utils/professionalIdentity');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`SELECT spr.id, spr.mobile, spr.email, spr.ward_id, spr.aadhar_number
      FROM self_punch_requests spr WHERE spr.id = $1`, ['63285616-8cb6-4b0e-b9b0-d6451270350c']);
    assert.equal(rows.length, 1);
    const employee = rows[0];
    const registration = await findProfessionalIdentityConflict(client, { mobile: employee.mobile, email: employee.email, empCode: 'PREVIEW-NEW-CODE-NOT-SAVED' });
    assert.equal(registration?.source, 'account');
    const approval = await findProfessionalIdentityConflict(client, { mobile: employee.mobile, email: employee.email,
      empCode: 'PREVIEW-NEW-CODE-NOT-SAVED', excludeRequestId: employee.id });
    assert.ok(approval);
    assert.notEqual(approval.id, employee.id);
    assert.equal(await hasAadhaarRequestAtWard(client, decryptAadhar(employee.aadhar_number), employee.ward_id), true);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ newCodeCannotBypassExistingMobileOrEmail: true,
      duplicateApprovalDetected: true, encryptedAadhaarDuplicateDetected: true, databaseWrites: false }));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
