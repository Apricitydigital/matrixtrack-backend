const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('vm');
function scheduler(paused=[],configs=[]){
 const calls=[];const claims=new Set();const module={exports:{}};
 class Clock extends Date {constructor(...args){super(...(args.length?args:['2026-09-15T02:00:00Z']));}}
 const dependencies={
 './whatsappSettings':{isReportEnabled:async id=>!paused.includes(id)},
 './whatsappScheduleConfig':{getAllSchedules:async()=>configs,parseRecipients:s=>s.split(',')},
 './msg91ZoneCommissionerReport':{previousReportDate:()=> '2026-09-14',sendZoneCommissionerWhatsAppReport:async args=>calls.push(args)},
 './msg91DailyBulletinNew':{sendDailyBulletinWhatsAppNew:async args=>calls.push(args)},
 './msg91HmsDailyBulletin':{sendHmsDailyBulletin:async args=>calls.push(args)},
 './whatsappDispatchGuard':{claimWhatsAppDispatch:async data=>{const key=JSON.stringify(data);if(claims.has(key))return false;claims.add(key);return true;},releaseWhatsAppDispatch:async()=>{}},
 '../config/db':{},
 };
 vm.runInNewContext(fs.readFileSync(require.resolve('../utils/whatsappCronScheduler'),'utf8'),{require:id=>dependencies[id],module,process:{env:{}},Date:Clock,console:{log(){},error(){},warn(){}}});
 return {...module.exports,calls};
}
const config=id=>({report_id:id,send_time:'07:30',days_of_week:['Tue'],recipients:'919131042937'});
test('scheduler skips paused zones and deduplicates repeated ticks',async()=>{
 const s=scheduler(['zone-commissioner-zone-2'],[config('zone-commissioner-zone-1'),config('zone-commissioner-zone-2')]);
 await s.runScheduledWhatsAppReports();assert.equal(s.calls.length,1);assert.equal(s.calls[0].zoneName,'Zone 1');assert.equal(s.calls[0].zoneData.dateISO,'2026-09-14');
 await s.runScheduledWhatsAppReports();assert.equal(s.calls.length,1);
});
test('master pause stops all scheduled zones',async()=>{const s=scheduler(['zone-commissioner'],[config('zone-commissioner-zone-1')]);await s.runScheduledWhatsAppReports();assert.equal(s.calls.length,0);});
test('both city reports receive explicit previous-day date',async()=>{const s=scheduler([],[config('daily-city-report'),config('hms-daily-bulletin')]);await s.runScheduledWhatsAppReports();assert.equal(s.calls.length,2);assert.ok(s.calls.every(x=>x.date==='2026-09-14'));});
test('no selected days or recipients means no messages',async()=>{const s=scheduler([],[{...config('zone-commissioner-zone-1'),days_of_week:[]},{...config('zone-commissioner-zone-2'),recipients:''}]);await s.runScheduledWhatsAppReports();assert.equal(s.calls.length,0);});
