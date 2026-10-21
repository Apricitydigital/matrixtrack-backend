// Read-only capability check supports deploying code before the optional schema.
let available=false;
async function hasAttendanceSite(client) {
 if(available)return true;
 const {rows}=await client.query(`SELECT 1 FROM information_schema.columns
 WHERE table_schema=current_schema() AND table_name='professional_attendance' AND column_name='kothi_id'`);
 available=rows.length>0;return available;
}
module.exports={hasAttendanceSite};
