const REPORT_TIMEZONE = 'Asia/Kolkata';
const istDate = (now = new Date()) => now.toLocaleDateString('en-CA', {timeZone: REPORT_TIMEZONE});
const shiftDate = (iso, days) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('Report date must be YYYY-MM-DD.');
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== iso) throw new Error('Invalid report date.');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0,10);
};
const displayDate = (iso, options = {}) => new Date(`${shiftDate(iso,0)}T12:00:00Z`).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric',timeZone:REPORT_TIMEZONE,...options});
const dailyDates = (overrideDate, offset = -1, now = new Date()) => {
    const isoDate = overrideDate ? shiftDate(overrideDate,0) : shiftDate(istDate(now),offset);
    return {isoDate,displayDate:displayDate(isoDate)};
};
const weeklyDates = (now = new Date()) => {
    // Preserve the stable report's rolling seven-day definition, including today.
    const endDate = istDate(now), startDate = shiftDate(endDate,-6);
    const format = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:REPORT_TIMEZONE});
    return {startDate,endDate,displayPeriod:`${format(startDate)} - ${format(endDate)}`};
};
const supervisorDates = (now = new Date()) => {
    const result = dailyDates(null,0,now);
    const day = new Date(`${result.isoDate}T00:00:00Z`).getUTCDay();
    return {...result,weekStartIso:shiftDate(result.isoDate,day===0?-6:1-day)};
};
module.exports = {istDate,shiftDate,displayDate,dailyDates,weeklyDates,supervisorDates};
