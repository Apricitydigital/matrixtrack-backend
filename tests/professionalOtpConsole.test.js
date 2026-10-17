const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../controllers/professionalOtpController.js'),'utf8');
const helper=source.slice(source.indexOf('const _sendOtpSms ='),source.indexOf('\nconst isDevOrTestMode'));
async function send(flag,failed=false){
  const events=[];const module={exports:{}};
  vm.runInNewContext(helper+'\nmodule.exports=_sendOtpSms;',{
    module,process:{env:{PROFESSIONAL_OTP_CONSOLE_DEBUG:flag}},resolveAndroidOtpHash:()=>'',
    sendSms:async()=>{events.push('sms');if(failed)throw Error('Test failure');},
    logger:{info:message=>events.push('info:'+message),warn:message=>events.push('warn:'+message)},
    console:{log:message=>events.push('console:'+message)},
  });
  await module.exports('9000001234','5678','professional_otp_login');return events;
}
test('OTP is hidden from console by default and when debug is false',async()=>{
  for(const flag of [undefined,'false'])assert.ok(!(await send(flag)).some(event=>event.includes('5678')));
});
test('explicit debug prints OTP after the SMS result with a masked mobile',async()=>{
  const events=await send('true');const debug=events.find(event=>event.startsWith('console:'));
  assert.match(debug,/OTP=5678/);assert.match(debug,/mobile=\.\.\.1234/);assert.ok(!debug.includes('9000001234'));
  assert.ok(events.indexOf(debug)>events.findIndex(event=>event.startsWith('info:')));
  assert.ok(!events.filter(event=>event.startsWith('info:')).some(event=>event.includes('5678')));
});
test('debug also displays the generated OTP after an SMS failure',async()=>{
  const events=await send('true',true);assert.match(events.at(-1),/OTPAuth DEBUG.*OTP=5678/);
});
