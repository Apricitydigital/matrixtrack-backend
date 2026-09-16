const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReportData, buildComponents, comparison, validateDate, normalizePhoneNumber } = require('../utils/msg91ZoneCommissionerReport');
const row = (changes = {}) => ({ ward_id: 1, kothi_name: 'A long location name that must not be truncated anywhere in this report', sector_id: 10, ward_name: 'A long ward name that must remain fully visible', total: 10, present: 8, on_leave: 1, absent: 1, punch_out: 6, gps: 7, previous_present: 28, ...changes });
const build = rows => buildReportData(rows, [{ name: 'Supervisor Full Name', ward_ids: [1] }], 'Zone 2', '2026-09-11', '2026-09-11 16:00:00');

test('computes previous seven calendar days, excluding current day', () => {
    assert.equal(comparison(8, 28), '100.0% above');
    assert.equal(comparison(0, 0), 'equal to');
    assert.equal(comparison(8, 0), 'up from zero in');
    assert.equal(comparison(1, 14), '50.0% below');
});
test('aggregates ward totals and includes zero attendance locations in rankings', () => {
    const report = build([row(), row({ ward_id: 2, sector_id: 20, ward_name: 'Zero Ward', kothi_name: 'Zero Kothi', total: 5, present: 0, on_leave: 0, absent: 5, punch_out: 0, gps: 0, previous_present: 0 })]);
    assert.equal(report.totalReg, '15');
    assert.equal(report.present, '8');
    assert.equal(report.absent, '6');
    assert.equal(report.attentionWard, 'Zero Ward');
    assert.equal(report.lowestKothiWorkers, '0');
    assert.equal(report.lowestKothiPct, '0.0%');
    assert.match(report.action1, /no attendance recorded on the report date/);
    assert.equal(report.punchOutCompliance, '75.0%');
});
test('maps all 29 variables, dynamic zone number, and full names', () => {
    const report = build([row()]);
    const components = buildComponents(report);
    assert.equal(report.title, 'Zone 2 Brief');
    assert.equal(components.body_1.value, '2');
    assert.equal(Object.keys(components).length, 29);
    assert.equal(components.body_14.value, row().ward_name);
    assert.equal(components.body_20.value, row().kothi_name);
    assert.ok(!Object.values(components).some(c => /N\/A|undefined|NaN/.test(c.value)));
    assert.throws(() => buildComponents({ ...report, action1: 'N/A' }), /missing/);
});
test('zero presence is not strong performance and has explicit zero-baseline text', () => {
    const report = build([row({ present: 0, on_leave: 0, absent: 10, punch_out: 0, gps: 0, previous_present: 0 })]);
    assert.equal(report.status, 'Needs Immediate Attention');
    assert.equal(report.attendanceCompliance, '0.0%');
    assert.equal(report.punchOutCompliance, 'No attendance recorded');
    assert.match(report.todayHighlight, /No attendance recorded/);
});
test('empty data fails instead of sending sample figures', () => {
    assert.throws(() => build([]), /No registered/);
});
test('validates dates and normalizes Indian phone numbers', () => {
    assert.equal(validateDate('2026-09-11'), '2026-09-11');
    assert.throws(() => validateDate('2026-02-30'));
    assert.throws(() => validateDate('not a date'));
    assert.equal(normalizePhoneNumber('9131042937'), '919131042937');
});

test('defaults to yesterday in India across midnight, month and year boundaries', () => {
 const { previousReportDate } = require('../utils/msg91ZoneCommissionerReport');
 assert.equal(previousReportDate(new Date('2026-09-11T12:00:00Z')), '2026-09-10');
 assert.equal(previousReportDate(new Date('2026-09-10T19:00:00Z')), '2026-09-10');
 assert.equal(previousReportDate(new Date('2026-09-10T18:00:00Z')), '2026-09-09');
 assert.equal(previousReportDate(new Date('2026-01-01T00:00:00Z')), '2025-12-31');
 assert.equal(previousReportDate(new Date('2024-03-01T00:00:00Z')), '2024-02-29');
});
test('action line is generated once and changes with the location data', () => {
 const r = build([row({kothi_name: 'Test Location', present: 0})]);
 assert.equal(r.action1, 'Test Location: no attendance recorded on the report date; verify deployment.');
 assert.equal(buildComponents(r).body_26.value, r.action1);
 assert.match(build([row({kothi_name: 'Other Location'})]).action1, /^Other Location:/);
});
