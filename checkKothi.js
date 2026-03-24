const {fetchUserKothiAccess}=require('./utils/userKothiAccess');
(async()=>{
 const res=await fetchUserKothiAccess({user_id:(await require('./config/db').query("select user_id from users where email='ashu@gmail.com'")).rows[0].user_id}, {allowZoneFallback:true, allowCityFallback:false});
 console.log(res);
 process.exit(0);
})();
