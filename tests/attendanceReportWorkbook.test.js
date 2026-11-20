const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createAttendanceDownloadHandler } = require('../utils/attendanceReportDownload');

for (const format of [undefined, 'xlsx', 'csv']) {
  test(`attendance download returns a readable xlsx for ${format || 'default'} format`, async () => {
    const headers = {};
    let body;
    const handler = createAttendanceDownloadHandler({
      pool: { query: async () => ({ rows: [] }) },
      resolveCityScope: () => ({ all: true, ids: [] }),
    });
    const res = {
      setHeader: (key, value) => { headers[key] = value; },
      send: value => { body = value; },
      status: code => { throw new Error(`Unexpected status ${code}`); },
    };
    await handler({ query: { date: '2026-11-20', ...(format ? { format } : {}) }, body: {}, protocol: 'https', get: () => 'example.test' }, res);
    assert.equal(headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(headers['Content-Disposition'], /\.xlsx"$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(body);
    assert.ok(workbook.getWorksheet('Report').rowCount > 0);
  });
}
