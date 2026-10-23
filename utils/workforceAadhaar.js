const {decryptAadhar}=require('./encryption');
function aadhaar(value){
 if(!value)return '';
 try { const raw=String(value).trim();const plain=(raw.includes(':')?decryptAadhar(raw):raw).replace(/[\s-]/g,'');return /^\d{12}$/.test(plain)&&! /^(\d)\1{11}$/.test(plain)?plain:''; }catch(_){return '';}
}
function reviewIdentity(row){const {aadhaar_stored,...safe}=row;return {...safe,aadhaar_number:aadhaar(aadhaar_stored)};}
function assertSameAadhaar(rows){
 const numbers=new Set(rows.map(row=>aadhaar(row.aadhaar_number)).filter(Boolean));
 if(numbers.size>1)throw Object.assign(new Error('Selected employees have different Aadhaar numbers. Verify and correct their details before merging.'),{status:409});
}
module.exports={aadhaar,reviewIdentity,assertSameAadhaar};
