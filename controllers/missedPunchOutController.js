const pool = require('../config/db');
const followUp = require('../utils/missedPunchOutFollowUp');

const getWarning = async (req,res) => {
  try {
    const employeeId=req.self_attendance?.self_attendance_id;
    if(!employeeId)return res.status(401).json({success:false,message:'Unauthorized Self Attendance session.'});
    const warning=await followUp.getPendingPunchOutWarning(pool,employeeId);
    res.json({success:true,data:warning});
  } catch(error) {
    console.error('[MissedPunchOutWarning]',error.message);
    res.status(500).json({success:false,message:'Unable to check the punch-out warning.'});
  }
};

const acknowledgeWarning = async (req,res) => {
  try {
    const employeeId=req.self_attendance?.self_attendance_id;
    if(!employeeId)return res.status(401).json({success:false,message:'Unauthorized Self Attendance session.'});
    const startDate=String(req.body?.streak_start_date||'');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate))return res.status(400).json({success:false,message:'A valid warning date is required.'});
    const result=await followUp.acknowledgePunchOutWarning(pool,employeeId,startDate);
    res.json({success:true,data:result});
  } catch(error) {
    const status=error.status||500;
    if(status===500)console.error('[MissedPunchOutWarning acknowledge]',error.message);
    res.status(status).json({success:false,message:status===500?'Unable to record your acknowledgment.':error.message});
  }
};

module.exports={getWarning,acknowledgeWarning};
