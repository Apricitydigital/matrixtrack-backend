const LIMITS=Object.freeze({employees:20000,records:50000,cells:250000});
function checkReportBudget(employeeCount,recordCount,days) {
 if(employeeCount>LIMITS.employees || recordCount>LIMITS.records || employeeCount*days>LIMITS.cells) {
  throw Object.assign(new Error('This report is too large. Choose a city/site or a shorter date range, then reload.'),{status:413});
 }
}
const id=value=>value==null || value==='' || value==='all'?null:/^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value))?Number(value):NaN;
function reportFilters(input={}) {
 const cityId=id(input.cityId),zoneId=id(input.zoneId),sectorId=id(input.sectorId);
 const sites=input.kothiIds==null || input.kothiIds===''?null:String(input.kothiIds).split(',').map(id);
 if([cityId,zoneId,sectorId].some(Number.isNaN) || (sites && (sites.length>1000 || sites.some(value=>value===null || Number.isNaN(value)))))throw Object.assign(new Error('Invalid report location filters.'),{status:400});
 return {cityId,zoneId,sectorId,sites};
}
const intersect=(allowed,selected)=>selected===null?allowed:allowed===null?selected:allowed.filter(id=>selected.includes(id));
module.exports={LIMITS,checkReportBudget,reportFilters,intersect};
