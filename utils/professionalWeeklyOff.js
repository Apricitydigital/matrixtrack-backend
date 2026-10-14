const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DESIGNATIONS = ['Project Head / Site Head', 'HO Coordinator', 'Country Head'];
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
function parseDay(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const index = DAYS.findIndex(day => day.toLowerCase() === text);
  if (index >= 0) return index;
  if (/^[0-6]$/.test(text)) return Number(text);
  throw Object.assign(new Error('Weekly-Off Day must be Sunday, Monday, Tuesday, Wednesday, Thursday, Friday or Saturday.'), { status: 400 });
}
function validateEffectiveDate(value, today = todayIST()) {
  const date = value || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date < today) {
    throw Object.assign(new Error('Effective date must be today or a valid future date.'), { status: 400 });
  }
  return date;
}
module.exports = { DAYS, DESIGNATIONS, todayIST, parseDay, validateEffectiveDate };
