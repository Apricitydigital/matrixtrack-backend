'use strict';
const {contractValue} = require('../utils/selfAttendanceNaming');
// Old installed apps keep their paths, JSON fields and filter values. New clients
// use /self-attendance or X-Attendance-Naming: self-attendance on shared endpoints.
module.exports = function selfAttendanceCompatibility(req,res,next) {
  try {
    const path = req.url.split('?')[0];
    const canonical = /(?:^|\/)self[-_]attendance(?:\/|-|$)/.test(path)
      || req.get('X-Attendance-Naming') === 'self-attendance'
      || [req.query?.employeeType,req.query?.employee_type,req.body?.employeeType,req.body?.employee_type].includes('self_attendance');
    const renamed = path.includes('/workforce-review/')
      ? path.replace(/\/professional(?=\/|$)/g,'/self_attendance')
      : path.replace(/professional-attendance/g,'self-attendance-records').replace(/professional(?=\/|-|$)/g,'self-attendance');
    req.url = renamed + req.url.slice(path.length);
    req.query = contractValue(req.query);
    if(req.body)req.body = contractValue(req.body);
    const json = res.json;
    res.json = function(body) { return json.call(this, canonical ? body : contractValue(body,'legacy')); };
    return next();
  } catch(error) { return res.status(error.status || 400).json({error:error.message}); }
};
