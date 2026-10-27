const test=require('node:test'),assert=require('node:assert/strict');
const {policy,androidAppVersionGate:gate,platformOf}=require('../utils/androidAppVersion');
const originalForceUpdate=process.env.ANDROID_FORCE_UPDATE;
test.beforeEach(()=>{process.env.ANDROID_FORCE_UPDATE='true';});
test.afterEach(()=>{if(originalForceUpdate===undefined)delete process.env.ANDROID_FORCE_UPDATE;else process.env.ANDROID_FORCE_UPDATE=originalForceUpdate;});
function request(headers={},path='/professional/supervisor-attendance/punch'){
 let passed=false;const res={status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};gate({headers,path},res,()=>{passed=true;});return {passed,...res};
}
const headers=(version,build)=>({'x-app-platform':'android','x-app-version':version,'x-app-build':build});
test('enforcement is opt-in until the Android release is available',()=>{
 delete process.env.ANDROID_FORCE_UPDATE;assert.equal(policy('android').forceUpdate,false);assert.equal(request(headers('1.0.18','66')).passed,true);assert.equal(policy('android').minVersion,'1.0.19');
});
test('old, missing and malformed native Android versions are blocked while current/future versions pass',()=>{
 for(const [v,b] of [['1.0.18','66'],['1.0.18','999'],['1.0.19','66'],['',''],['invalid','67']]){const r=request(headers(v,b));assert.equal(r.statusCode,426);assert.equal(r.body.code,'APP_UPDATE_REQUIRED');assert.equal(r.passed,false);}
 for(const [v,b] of [['1.0.19','67'],['1.0.20','68'],['1.1.0','100']])assert.equal(request(headers(v,b)).passed,true);
 assert.equal(request({'user-agent':'okhttp/4.12.0'}).statusCode,426);
});
test('version discovery remains accessible and iOS/browser clients are not blocked',()=>{
 assert.equal(request({'user-agent':'okhttp/4.12.0'},'/app/config/version').passed,true);
 for(const h of [{},{'user-agent':'Mozilla/5.0 (Linux; Android 14)'},{'x-app-platform':'ios'}])assert.equal(request(h).passed,true);
 assert.equal(policy('android').minVersion,'1.0.19');assert.equal(policy('android').minVersionCode,67);assert.equal(policy('android').forceUpdate,true);assert.equal(policy('ios').forceUpdate,false);assert.equal(policy('web').forceUpdate,false);
 assert.equal(platformOf({headers:{'user-agent':'MatrixTrack/1 CFNetwork Darwin'}}),'ios');
});
test('an operational rollback flag disables enforcement',()=>{
 const previous=process.env.ANDROID_FORCE_UPDATE;try{process.env.ANDROID_FORCE_UPDATE='false';assert.equal(request(headers('1.0.18','66')).passed,true);assert.equal(policy('android').forceUpdate,false);}finally{if(previous===undefined)delete process.env.ANDROID_FORCE_UPDATE;else process.env.ANDROID_FORCE_UPDATE=previous;}
});

test('the public version endpoint gives legacy Android clients the mandatory policy without cache',async()=>{
 const router=require('../routes/appRoutes/updateRoutes');
 const call=query=>new Promise((resolve,reject)=>{const result={};router.handle({method:'GET',url:'/version',headers:{},query},{set(key,value){result[key]=value;return this;},json(data){resolve({...result,data});}},reject);});
 let result=await call({});assert.equal(result.data.forceUpdate,true);assert.equal(result.data.minVersion,'1.0.19');assert.equal(result['Cache-Control'],'no-store');result=await call({platform:'ios'});assert.equal(result.data.forceUpdate,false);
});
