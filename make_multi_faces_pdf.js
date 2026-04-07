const fs = require("fs");
const PDFDocument = require("pdfkit");

const input = "multi_faces_report.json";
const output = "multi_faces_report.pdf";

if (!fs.existsSync(input)) {
  console.error(`Input file not found: ${input}`);
  process.exit(1);
}

let raw = fs.readFileSync(input);
let text;
if (raw[0] === 0xFF && raw[1] === 0xFE) {
  text = raw.toString("utf16le");
} else if (raw[0] === 0xFE && raw[1] === 0xFF) {
  text = raw.swap16().toString("utf16le");
} else {
  text = raw.toString("utf8");
}
text = text.replace(/^\uFEFF/, "");
let data;
try {
  data = JSON.parse(text);
} catch (e) {
  console.error("Failed to parse JSON:", e.message);
  process.exit(1);
}

const doc = new PDFDocument({ margin: 36, size: "A4" });
doc.pipe(fs.createWriteStream(output));

doc.fontSize(16).text("Employees with Multiple Face Images", { align: "center" });
doc.moveDown(0.5);
doc.fontSize(9).text(`Generated: ${new Date().toISOString()}`, { align: "center" });
doc.moveDown(1);

const headers = [
  "Emp ID", "Emp Code", "Name", "Images", "City", "Zone", "Ward No", "Ward Name", "Kothi"
];

const colWidths = [50, 70, 120, 40, 90, 90, 45, 120, 110];
const startX = doc.x;
let y = doc.y;
const lineHeight = 14;

function drawRow(cells, bold=false) {
  doc.font(bold ? "Helvetica-Bold" : "Helvetica");
  let x = startX;
  for (let i=0;i<cells.length;i++) {
    doc.text(String(cells[i] ?? ""), x, y, { width: colWidths[i], height: lineHeight, ellipsis: true });
    x += colWidths[i];
  }
  y += lineHeight;
  if (y > doc.page.height - 50) {
    doc.addPage();
    y = doc.y;
    drawRow(headers, true);
    drawLine();
  }
}

function drawLine() {
  doc.moveTo(startX, y).lineTo(startX + colWidths.reduce((a,b)=>a+b,0), y).stroke();
  y += 2;
}

drawRow(headers, true);
drawLine();

data.forEach((row) => {
  drawRow([
    row.emp_id,
    row.emp_code,
    row.name,
    row.images,
    row.city,
    row.zone,
    row.ward_no,
    row.ward_name,
    row.kothi_name,
  ]);
});

// footer
if (y < doc.page.height - 40) {
  doc.moveTo(startX, doc.page.height - 40).lineTo(startX + colWidths.reduce((a,b)=>a+b,0), doc.page.height - 40).stroke();
  doc.fontSize(8).text("Only employees with more than one face image are listed.", startX, doc.page.height - 35);
}

doc.end();
console.log(`Written ${output}`);
