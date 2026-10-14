const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDay, validateEffectiveDate } = require('../utils/professionalWeeklyOff');
test('weekly-off input accepts weekday names and rejects blank/invalid days', () => {
  assert.equal(parseDay(' Monday '), 1);
  assert.equal(parseDay('sunday'), 0);
  assert.equal(parseDay(6), 6);
  for (const value of ['',null,undefined,'Mon','7',-1,'1.5']) assert.throws(() => parseDay(value));
});
test('effective dates preserve past payroll and reject impossible dates', () => {
  assert.equal(validateEffectiveDate(undefined,'2026-10-09'),'2026-10-09');
  assert.equal(validateEffectiveDate('2026-11-01','2026-10-09'),'2026-11-01');
  for (const value of ['2026-10-08','2026-02-30','2026-13-01','09-10-2026','2026-10-10junk']) assert.throws(() => validateEffectiveDate(value,'2026-10-09'));
});
