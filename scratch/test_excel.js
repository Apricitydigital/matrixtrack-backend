const ExcelJS = require("exceljs");

async function runTest() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Supervisor Attendance");

  // Headings
  worksheet.mergeCells("A1:J1");
  const titleCell = worksheet.getCell("A1");
  titleCell.value = `Supervisor Attendance Report (2026-05-01 to 2026-06-01)`;

  const headers = [
    "S.No.",
    "Supervisor Name",
    "Mobile No",
    "City",
    "Zone",
    "Ward",
    "Kothi",
    "Present Days",
    "Absent Days",
    "Attendance %",
  ];

  worksheet.addRow(headers);

  // Add dummy row matching the structure in SupervisorAttendance.js
  const dummyRow = [
    1,
    "Aakash Sharad Bathe",
    "9823890094",
    "Pune",
    "Zone 1",
    "Ward A",
    "Kothi B",
    15,
    5,
    "75.0%"
  ];
  worksheet.addRow(dummyRow);

  console.log("--- Column details ---");
  worksheet.columns.forEach((column, colIdx) => {
    let maxLen = 0;
    console.log(`\nColumn ${colIdx + 1}:`);
    column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
      const valStr = cell.value ? cell.value.toString() : "";
      console.log(`  Row ${rowNumber}: value="${valStr}" (type: ${typeof cell.value}, isMerged: ${cell.isMerged})`);
      if (rowNumber === 1) return;
      if (valStr.length > maxLen) maxLen = valStr.length;
    });
    const calculatedWidth = Math.max(maxLen + 4, 12);
    console.log(`  => Max length (excluding Row 1): ${maxLen}, Width: ${calculatedWidth}`);
  });
}

runTest();
