const UPDATE_URL='https://play.google.com/store/apps/details?id=com.apricitydigital.attendeaseApp';
function policy(platform='android'){
 const android=platform==='android';
 const version=/^\d+\.\d+\.\d+$/.test(process.env.ANDROID_MIN_APP_VERSION||'')?process.env.ANDROID_MIN_APP_VERSION:'1.0.19';
 const build=Number(process.env.ANDROID_MIN_VERSION_CODE);
 return {platform,latestVersion:'1.0.19',minVersion:android?version:'1.0.0',
  minVersionCode:android?(Number.isSafeInteger(build)&&build>0?build:67):null,
  forceUpdate:android&&process.env.ANDROID_FORCE_UPDATE==='true',updateUrl:process.env.ANDROID_UPDATE_URL||UPDATE_URL,
  message:'Please update MatrixTrack to continue using the app.'};
}
function older(version,minimum){
 if(!/^\d+\.\d+\.\d+$/.test(String(version)))return true;
 const a=version.split('.').map(Number),b=minimum.split('.').map(Number);
 for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]<b[i];}return false;
}
function platformOf(req){
 const explicit=String(req.headers?.['x-app-platform']||req.query?.platform||'').toLowerCase();
 if(['android','ios','web'].includes(explicit))return explicit;
 const agent=String(req.headers?.['user-agent']||'');
 if(/CFNetwork|Darwin|iPhone|iPad/i.test(agent))return 'ios';
 return 'android'; // Existing Android releases request /version without platform metadata.
}
function androidAppVersionGate(req,res,next){
 const path=String(req.path||req.url||'').split('?')[0];
 if(path==='/app/config/version')return next();
 // An image capability is checked by the photo guard, not by the native app version gate.
 if(['GET','HEAD'].includes(req.method)&&path.toLowerCase().replace(/\/+$/,'')==='/app/attendance/employee/image'&&req.query?.image_access)return next();
 const explicit=String(req.headers?.['x-app-platform']||'').toLowerCase();
 const android=explicit==='android'||(!explicit&&/^okhttp\//i.test(String(req.headers?.['user-agent']||'')));
 if(!android)return next(); // Browser and iOS routes retain their current behavior.
 const config=policy('android');if(!config.forceUpdate)return next();
 const version=String(req.headers?.['x-app-version']||''),build=String(req.headers?.['x-app-build']||'');
 if(older(version,config.minVersion)||!/^\d+$/.test(build)||Number(build)<config.minVersionCode)
  return res.status(426).json({success:false,code:'APP_UPDATE_REQUIRED',...config});
 next();
}
module.exports={policy,older,platformOf,androidAppVersionGate};
