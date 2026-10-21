const normalizeMobile=value=>{
 if(/[^\d+\s().-]/.test(String(value || '')))return '';
 const digits=String(value || '').replace(/\D/g,'');
 return /^(?:0091|91)\d{10}$/.test(digits)?digits.slice(-10):digits;
};
const passwordHash=profile=>Object.hasOwn(profile,'password_hash')?profile.password_hash:profile.password;
const identifierCondition=`(a.email=$1 OR a.mobile=$2 OR (length($3)=10 AND a.mobile_normalized=$3))`;
async function findProfessionalLogin(client,identifier,rawIdentifier,column,useAliases=true) {
 if(!['password_hash','password'].includes(column))throw Error('Unsupported password column');
 const params=[identifier,rawIdentifier,normalizeMobile(rawIdentifier)];
 const {rows}=await client.query(`SELECT pe.id,pe.email,pe.mobile,pe.${column} AS password_hash,
 pe.is_active,pe.face_locked,pe.ward_id,pe.zone_id,pe.city_id
 FROM professional_employees pe WHERE LOWER(TRIM(pe.email))=$1 OR pe.mobile=$1 OR pe.mobile=$2
 ${useAliases?`OR EXISTS(SELECT 1 FROM workforce_professional_login_aliases a WHERE a.target_id=pe.id AND ${identifierCondition})`:''}
 ORDER BY pe.is_active DESC,(SELECT COUNT(*) FROM professional_attendance pa WHERE pa.professional_id=pe.id) DESC,pe.created_at DESC,pe.id LIMIT 1`,useAliases?params:params.slice(0,2));
 const professional=rows[0];
 if(!professional || !useAliases)return {professional:professional || null,retiredHashes:[]};
 const aliases=await client.query(`SELECT DISTINCT a.password_hash FROM workforce_professional_login_aliases a
 WHERE a.target_id=$4 AND ${identifierCondition} AND a.password_hash IS NOT NULL
 AND a.main_password_hash IS NOT DISTINCT FROM $5`,[...params,professional.id,professional.password_hash]);
 return {professional,retiredHashes:aliases.rows.map(row=>row.password_hash)};
}
async function findProfessionalMobile(client,mobile,useAliases=true) {
 return client.query(`SELECT pe.id,pe.full_name,pe.is_active FROM professional_employees pe
 WHERE pe.mobile=$1 OR pe.mobile=$2 ${useAliases?`OR EXISTS(SELECT 1 FROM workforce_professional_login_aliases a
 WHERE a.target_id=pe.id AND a.mobile_normalized=$1)`:''}
 ORDER BY pe.is_active DESC,pe.created_at DESC,pe.id LIMIT 1`,[normalizeMobile(mobile),`+91${normalizeMobile(mobile)}`]);
}
async function retainMergedLogins(client,plan) {
 if(plan.kind!=='professional')return;
 const target=plan.profiles.find(row=>row.id===plan.targetId),mainHash=passwordHash(target);
 for(const source of plan.profiles.filter(row=>row.id!==plan.targetId)) {
  // Flatten previous merges. A password invalidated by a previous reset must
  // stay invalid; merging again cannot revive it under a new main password.
  await client.query(`UPDATE workforce_professional_login_aliases SET target_id=$1,
   password_hash=CASE WHEN main_password_hash IS NOT DISTINCT FROM $3 THEN password_hash ELSE NULL END,
   main_password_hash=$4 WHERE target_id=$2`,[target.id,source.id,passwordHash(source),mainHash]);
  await client.query(`INSERT INTO workforce_professional_login_aliases(source_id,target_id,email,mobile,mobile_normalized,password_hash,main_password_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[source.id,target.id,String(source.email || '').trim().toLowerCase() || null,source.mobile || null,normalizeMobile(source.mobile) || null,passwordHash(source),mainHash]);
 }
}
module.exports={normalizeMobile,passwordHash,findProfessionalLogin,findProfessionalMobile,retainMergedLogins};
