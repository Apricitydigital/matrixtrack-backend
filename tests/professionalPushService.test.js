// Provider mocks only. These tests never contact Expo, SNS, or a live database.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load({tokens=[],tickets,networkFailure=false,snsFailure=false}={}){
 const queries=[],expo=[],sns=[];
 class Command{constructor(input){this.input=input;}}
 class SNSClient{async send(command){sns.push(command.input);if(snsFailure)throw Object.assign(Error('Endpoint disabled'),{name:'EndpointDisabled'});return {};}}
 const pool={query:async(sql,params)=>{queries.push({sql,params});return {rows:sql.includes('SELECT professional_id, expo_push_token')?tokens:[]};}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync('utils/professionalPushService.js','utf8'),{
  module,console:{warn(){}},process:{env:{}},require:name=>{
   if(name==='../config/db')return pool;
   if(name==='axios')return {post:async(url,messages)=>{expo.push({url,messages});if(networkFailure)throw Error('Offline');return {data:{data:tickets||messages.map(()=>({status:'ok'}))}};}};
   if(name==='@aws-sdk/client-sns')return {SNSClient,CreatePlatformEndpointCommand:Command,GetEndpointAttributesCommand:Command,SetEndpointAttributesCommand:Command,PublishCommand:Command};
   throw Error(name);
  },
 });return {send:module.exports.sendPushToProfessionals,queries,expo,sns};
}
const notification={id:'notification-1',professional_id:'professional-1',type:'punch-in-reminder',title:'Punch in',message:'Please mark attendance',metadata:{reminder_date:'2026-10-26'}};
const expoToken={professional_id:notification.professional_id,expo_push_token:'ExponentPushToken[test]',push_provider:'expo'};
test('Expo reminders use the registered default Android channel and preserve reminder metadata',async()=>{
 const f=load({tokens:[expoToken]});const result=await f.send([notification]);assert.equal(result.sent,1);assert.equal(result.failed,0);
 const message=f.expo[0].messages[0];assert.equal(message.channelId,'default');assert.equal(message.sound,'default');assert.equal(message.title,notification.title);assert.equal(message.body,notification.message);assert.equal(message.data.metadata.reminder_date,'2026-10-26');
});
test('missing device registrations are reported rather than counted as sent',async()=>{
 const f=load();const result=await f.send([notification]);assert.equal(result.sent,0);assert.equal(result.noDestination,1);assert.equal(f.expo.length,0);assert.equal(f.sns.length,0);
});
test('invalid Expo tokens are disabled and delivery failures are not counted as success',async()=>{
 const f=load({tokens:[expoToken],tickets:[{status:'error',details:{error:'DeviceNotRegistered'}}]});const result=await f.send([notification]);assert.equal(result.sent,0);assert.equal(result.failed,1);assert.equal(result.invalidated,1);assert.ok(f.queries.some(q=>q.sql.includes('SET is_active = FALSE')));
});
test('network failure keeps the token active and reports failed delivery',async()=>{
 const f=load({tokens:[expoToken],networkFailure:true});const result=await f.send([notification]);assert.equal(result.sent,0);assert.equal(result.failed,1);assert.equal(result.invalidated,0);
});
test('SNS Android and iOS pushes preserve alert content and sound',async()=>{
 for(const provider of ['fcm','apns']){const f=load({tokens:[{professional_id:notification.professional_id,push_provider:provider,platform_endpoint_arn:'arn:test:device'}]});const result=await f.send([notification]);assert.equal(result.sent,1);const payload=JSON.parse(f.sns[0].Message);const body=JSON.parse(provider==='fcm'?payload.GCM:payload.APNS);assert.equal(provider==='fcm'?body.notification.title:body.aps.alert.title,notification.title);assert.equal(provider==='fcm'?body.notification.sound:body.aps.sound,'default');}
});
test('disabled SNS endpoint is invalidated instead of claiming a successful reminder',async()=>{
 const f=load({tokens:[{professional_id:notification.professional_id,push_provider:'fcm',platform_endpoint_arn:'arn:test:device'}],snsFailure:true});const result=await f.send([notification]);assert.equal(result.sent,0);assert.equal(result.failed,1);assert.equal(result.invalidated,1);
});
