const HEADERS=['Employee Code','Employee Name','City ID','City Name','Site ID','Site Name','Punch-in Cutoff (IST)'];
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
function parseCutoff(value) {
  if(value instanceof Date) {
    if(!Number.isFinite(value.getTime()) || value.getUTCSeconds() || value.getUTCMilliseconds()) fail('Use a time without seconds.');
    return `${String(value.getUTCHours()).padStart(2,'0')}:${String(value.getUTCMinutes()).padStart(2,'0')}`;
  }
  if(typeof value==='number') {
    if(!Number.isFinite(value) || value<0 || value>=1) fail('Invalid Excel time; use HH:mm.');
    const minutes=Math.round(value*1440);
    if(Math.abs(value*1440-minutes)>0.00001 || minutes>=1440) fail('Use a valid time without seconds.');
    return `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
  }
  const text=String(value ?? '').trim();
  const match=text.match(/^(\d{1,2}):([0-5]\d)(?::00)?\s*(AM|PM)?$/i);
  if(!match) fail('Enter a valid 24-hour time, for example 09:30.');
  let hour=Number(match[1]);
  if(match[3]) {
    if(hour<1 || hour>12) fail('Invalid AM/PM time.');
    hour=hour%12+(match[3].toUpperCase()==='PM' ? 12 : 0);
  } else if(hour>23) fail('Hour must be between 00 and 23.');
  return `${String(hour).padStart(2,'0')}:${match[2]}`;
}
function plainCell(cell) {
  if(cell.value && typeof cell.value==='object' && ('formula' in cell.value || 'sharedFormula' in cell.value)) fail('Use plain values, not formulas.');
  return cell.value instanceof Date || typeof cell.value==='number' ? cell.value : cell.text.trim();
}
module.exports={HEADERS,parseCutoff,plainCell};
