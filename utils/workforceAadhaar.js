const {decryptAadhar}=require('./encryption');
function aadhaar(value){
 if(!value)return '';
 try { const raw=String(value).trim();const plain=(raw.includes(':')?decryptAadhar(raw):raw).replace(/[\s-]/g,'');return /^\d{12}$/.test(plain)&&! /^(\d)\1{11}$/.test(plain)?plain:''; }catch(_){return '';}
}
function reviewIdentity(row){const {aadhaar_stored,...safe}=row;return {...safe,aadhaar_number:aadhaar(aadhaar_stored)};}
function assertSameAadhaar(rows){
 const numbers=new Set(rows.map(row=>aadhaar(row.aadhaar_number)).filter(Boolean));
 if(numbers.size<=1)return;
 // A mistaken Aadhaar may be retired only with a direct mobile + assigned-site
 // match to the chosen main account. Never infer this through another source.
 const main=rows[0];
 const mobile=value=>String(value || '').replace(/\D/g,'').replace(/^91(?=\d{10}$)/,'');
 const phone=mobile(main.mobile);
 if(phone.length===10 && main.site_id!=null && main.city_id!=null && rows.every(row=>
  row.kind===main.kind && row.site_id!=null && row.city_id!=null &&
  String(row.site_id)===String(main.site_id) && String(row.city_id)===String(main.city_id) && mobile(row.mobile)===phone))return;
 throw Object.assign(new Error('Different Aadhaar numbers require the same mobile number, city and assigned site on every selected account. Verify their details before merging.'),{status:409});
}
module.exports={aadhaar,reviewIdentity,assertSameAadhaar};
