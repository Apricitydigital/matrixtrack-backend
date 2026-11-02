'use strict';
// Only the deployment migration and the HTTP compatibility boundary know old names.
const legacyNames = require('../config/selfAttendanceLegacyNames.json');
function renameIdentifier(value) {
  return String(value).replace(/professional-attendance/g, 'self-attendance-records')
    .replace(/professional_attendance/g, 'self_attendance_records')
    .replace(/ProfessionalAttendance/g, 'SelfAttendanceRecords')
    .replace(/professionalAttendance/g, 'selfAttendanceRecords')
    .replace(/PROFESSIONAL_ATTENDANCE/g, 'SELF_ATTENDANCE_RECORDS')
    .replace(/PROFESSIONAL/g, 'SELF_ATTENDANCE').replace(/Professional/g, 'SelfAttendance')
    .replace(/professional(?=[A-Z])/g, 'selfAttendance').replace(/professional-/g,'self-attendance-').replace(/professional/g, 'self_attendance');
}
function renameSql(value) {
  return renameIdentifier(value).replace(/(['"])SelfAttendance(?: Attendance)?\1/g, (_, quote) => quote + 'Self Attendance' + quote);
}
const semanticFields = new Set(['employee_kind','employee_type','employeeType','employee_type_filter','kind','actor_type','user_type','userType','attendance_mode',
  'type','module','table','table_name','column','column_name','field','key_columns','columns','source_table','reference_column','permission','code','role','audience','source']);
const reverseNames = Object.fromEntries(Object.entries(legacyNames).map(([oldName,newName]) => [newName,oldName]));
// These aliases need a unique, stable reverse spelling at the API boundary.
Object.assign(reverseNames, {self_attendance: 'professional', 'Self Attendance': 'Professional', self_attendance_id: 'professional_id'});
function contractValue(value, direction = 'canonical', field = '') {
  const names = direction === 'canonical' ? legacyNames : reverseNames;
  const convert = token => Object.hasOwn(names,token) ? names[token] : token;
  if (Array.isArray(value)) return value.map(item => contractValue(item,direction,field));
  if (value && [Object.prototype,null].includes(Object.getPrototypeOf(value))) {
    const result = {};
    for (const [key,item] of Object.entries(value)) {
      const newKey = convert(key);
      if (Object.hasOwn(result,newKey)) throw Object.assign(Error('Conflicting attendance field names.'), {status:400});
      Object.defineProperty(result,newKey,{value:contractValue(item,direction,key),enumerable:true,writable:true,configurable:true});
    }
    return result;
  }
  if (typeof value !== 'string') return value;
  if (semanticFields.has(field)) return convert(value);
  if (['id','emp_id','employee_id','source_employee_id','attendance_id','source_attendance_id'].includes(field)) {
    const from = direction === 'canonical' ? 'professional:' : 'self_attendance:';
    const to = direction === 'canonical' ? 'self_attendance:' : 'professional:';
    if(value.startsWith(from)) return to+value.slice(from.length);
  }
  return value;
}
function loadLegacyEnvironment(env = process.env) {
  for (const [key,value] of Object.entries(env)) if (key.startsWith('PROFESSIONAL_')) {
    const renamed = renameIdentifier(key);
    if (env[renamed] === undefined) env[renamed] = value;
  }
}
module.exports = {renameIdentifier,renameSql,contractValue,loadLegacyEnvironment,semanticFields};
