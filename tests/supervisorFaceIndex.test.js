const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),sharp=require('sharp');
function setup(count=1,answers=[],photoResponse){
 const calls=[];let active=0,maximum=0,index=0;
 const commands={};for(const name of ['CreateCollection','DetectFaces','IndexFaces','SearchFacesByImage','DeleteFaces','PutObject','GetObject','DeleteObject'])commands[name+'Command']=class{constructor(input){this.input=input;this.kind=name;}};
 const face={Confidence:99,Quality:{Sharpness:90},BoundingBox:{Left:0,Top:0,Width:1,Height:1}};
 const client={send:async command=>{
  calls.push(command);if(command.kind==='DetectFaces')return {FaceDetails:Array.from({length:count},()=>face)};
  if(command.kind==='GetObject')return photoResponse;
  if(command.kind==='SearchFacesByImage'){const answer=answers[index++]||[];active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));active--;return {FaceMatches:answer};}
  if(command.kind==='IndexFaces')return {FaceRecords:[{Face:{FaceId:'new-face'}}]};return {};
 }};
 const deps={sharp,'node:crypto':require('node:crypto'),axios:{},'../config/awsConfig':{...commands,rekognition:client,s3:client},'./s3SelfPunch':{getSignedS3Url:()=>''},'./cityTrafficCost':{sendTrackedRekognition:({client,command})=>client.send(command)}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../utils/supervisorFaceIndex'),'utf8'),{module,exports:module.exports,require:n=>deps[n],Buffer,AbortSignal,process:{env:{AWS_S3_BUCKET:'test-private-bucket',AWS_REGION:'ap-south-1'}},URL});
 return {api:module.exports,calls,max:()=>maximum};
}
const match=(id,emp,score=99)=>({Similarity:score,Face:{FaceId:id,ExternalImageId:`employee-${emp}`}});
const roster=[{emp_id:1,face_id:'face-1'},{emp_id:2,face_id:'face-2'}];
const picture=()=>sharp({create:{width:120,height:120,channels:3,background:'white'}}).jpeg().toBuffer();
test('indexed searches accept only current kothi face IDs and matching employee identity',async()=>{
 const s=setup(1,[[match('foreign',3,100),match('face-1',999,100),match('face-2',2,96),match('face-1',1,99)]]);
 const result=await s.api.matchFaces(12,await picture(),roster,true,4);assert.equal(result[0].employee.emp_id,1);
 assert.ok(s.calls.filter(c=>c.kind==='SearchFacesByImage').every(c=>c.input.CollectionId==='matrixtrack-supervisor-site-12'));
 assert.ok(s.calls.every(c=>c.kind!=='CompareFaces'));
});
test('ambiguous matches and repeated faces never mark an employee',async()=>{
 let s=setup(1,[[match('face-1',1,99),match('face-2',2,98)]]);
 assert.match((await s.api.matchFaces(12,await picture(),roster,true))[0].reason,/ambiguous/);
 s=setup(2,[[match('face-1',1)],[match('face-1',1)]]);
 assert.ok((await s.api.matchFaces(12,await picture(),roster,true)).every(r=>!r.employee&&/more than once/.test(r.reason)));
});
test('group searches are bounded to four in flight and reject invalid capture sizes',async()=>{
 const s=setup(9);assert.equal((await s.api.matchFaces(7,await picture(),roster,true)).length,9);assert.equal(s.max(),4);
 for(const [count,group] of [[0,true],[21,true],[2,false]]){
  const t=setup(count);await assert.rejects(t.api.matchFaces(7,await picture(),roster,group),e=>e.status===422);
  assert.equal(t.calls.filter(c=>c.kind==='SearchFacesByImage').length,0);
 }
});
test('enrollment refuses a face already assigned to another employee in the site',async()=>{
 const s=setup(1,[[match('existing',2)]]);await assert.rejects(s.api.indexFace(7,1,await picture(),4),e=>e.status===409);
 assert.equal(s.calls.filter(c=>c.kind==='IndexFaces').length,0);
 const t=setup(1);assert.equal((await t.api.indexFace(7,1,await picture(),4)).collectionId,'matrixtrack-supervisor-site-7');
 assert.equal(t.calls.find(c=>c.kind==='IndexFaces').input.ExternalImageId,'employee-1');
});

test('new group photos are uploaded privately without a public ACL',async()=>{
 const {api,calls}=setup();const key=await api.putPhoto(Buffer.from('image'),'punches/10');assert.match(key,/^supervisor-attendance\/punches\/10\//);
 const upload=calls.find(c=>c.kind==='PutObject');assert.equal(upload.input.Bucket,'test-private-bucket');assert.equal(upload.input.ACL,undefined);assert.equal(upload.input.ContentType,'image/jpeg');
});

test('S3 photos are bounded before allocation and during streaming',async()=>{
 let destroyed=0,read=0;
 let s=setup(1,[],{ContentLength:9*1024*1024,Body:{destroy(){destroyed++;},transformToByteArray(){read++;}}});
 await assert.rejects(s.api.readPhoto('large.jpg'),e=>e.status===422);assert.equal(destroyed,1);assert.equal(read,0);
 const body={async *[Symbol.asyncIterator](){yield Buffer.alloc(5*1024*1024);yield Buffer.alloc(4*1024*1024);},destroy(){destroyed++;}};
 s=setup(1,[],{Body:body});await assert.rejects(s.api.readPhoto('unknown-size.jpg'),e=>e.status===422);assert.equal(destroyed,2);
 s=setup(1,[],{Body:{async *[Symbol.asyncIterator](){yield Buffer.from('valid');}}});assert.equal((await s.api.readPhoto('small.jpg')).toString(),'valid');
});
