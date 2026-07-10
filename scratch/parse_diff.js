const fs = require("fs");

const content = fs.readFileSync("scratch/face_attendance_diff.txt", "utf8");
const lines = content.split(/\r?\n/);

const filtered = [];
let chunkInfo = "";

for (const line of lines) {
  if (line.startsWith("@@")) {
    chunkInfo = line;
    filtered.push("\n" + line);
  } else if (line.startsWith("+") || line.startsWith("-")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      filtered.push(line);
      continue;
    }
    // Skip comment character noise
    if (line.includes("├â╞Æ") || line.includes("Ãƒ") || line.includes("🔒") || line.includes("📍") || line.includes("⚡") || line.includes("🛡️")) {
      continue;
    }
    filtered.push(line);
  }
}

fs.writeFileSync("scratch/filtered_diff.txt", filtered.join("\n"));
console.log("Filtered diff written to scratch/filtered_diff.txt");
