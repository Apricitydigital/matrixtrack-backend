// Register schedules only after database startup has committed. In particular,
// minute-based jobs cannot initialize competing schema transactions at startup.
function createStartupCron(cron) {
 const pending=[];
 let started=false;
 return {
  schedule(...args){if(started)return cron.schedule(...args);pending.push(args);},
  start(){if(started)return;started=true;for(const args of pending)cron.schedule(...args);pending.length=0;},
 };
}
module.exports={createStartupCron};
