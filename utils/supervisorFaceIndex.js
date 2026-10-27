const sharp=require('sharp');
const crypto=require('node:crypto');
const axios=require('axios');
const {rekognition,s3,CreateCollectionCommand,DetectFacesCommand,IndexFacesCommand,SearchFacesByImageCommand,DeleteFacesCommand,PutObjectCommand,GetObjectCommand,DeleteObjectCommand}=require('../config/awsConfig');
const {getSignedS3Url}=require('./s3SelfPunch');
const {sendTrackedRekognition}=require('./cityTrafficCost');
const bucket=()=>process.env.AWS_S3_BUCKET||process.env.S3_BUCKET_NAME;
const threshold=97;
const fail=(message,status=422,code)=>{throw Object.assign(Error(message),{status,code});};
const collectionFor=site=>`matrixtrack-supervisor-site-${site}`;
const run=(command,cityId)=>sendTrackedRekognition({client:{send:c=>rekognition.send(c,{abortSignal:AbortSignal.timeout(12000)})},command,cityId,source:'workspace_supervisor_attendance'});
async function photoBody(response){
 const limit=8*1024*1024;
 if(Number(response.ContentLength)>limit){response.Body?.destroy?.();fail('Saved photo is too large. Capture a new face photo.');}
 if(response.Body?.[Symbol.asyncIterator]){
  const chunks=[];let size=0;
  for await(const chunk of response.Body){const buffer=Buffer.from(chunk);size+=buffer.length;if(size>limit){response.Body.destroy?.();fail('Saved photo is too large. Capture a new face photo.');}chunks.push(buffer);}
  return Buffer.concat(chunks);
 }
 const buffer=Buffer.from(await response.Body.transformToByteArray());if(buffer.length>limit)fail('Saved photo is too large. Capture a new face photo.');return buffer;
}
async function normalize(buffer){
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>8*1024*1024)fail('Choose a photo under 8 MB.');
 try{return await sharp(buffer,{limitInputPixels:30000000}).rotate().resize({width:1920,height:1920,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();}
 catch(_){fail('The photo could not be read. Capture a new photo.');}
}
async function ensureCollection(site){try{await rekognition.send(new CreateCollectionCommand({CollectionId:collectionFor(site)}),{abortSignal:AbortSignal.timeout(12000)});}catch(e){if(e.name!=='ResourceAlreadyExistsException')throw e;}}
async function loadPhoto(ref){
 if(/^https?:\/\//.test(ref)){
  const url=new URL(ref);
  if(url.protocol!=='https:')fail('Saved photo must use secure storage.');
  if(url.hostname.endsWith('.backblazeb2.com'))return Buffer.from((await axios.get(ref,{responseType:'arraybuffer',timeout:10000,maxContentLength:8*1024*1024,maxRedirects:0})).data);
  if(!url.hostname.endsWith('.amazonaws.com'))fail('Saved photo storage is not supported. Ask HR to check it.');
  const hostBucket=url.hostname.split('.s3')[0];
  const allowed=[bucket(),process.env.SECONDARY_S3_BUCKET,'attend-ease-images','dailyfacerecord'].filter(Boolean);
  if(!allowed.includes(hostBucket))fail('Saved photo bucket is unavailable.');
  const response=await s3.send(new GetObjectCommand({Bucket:hostBucket,Key:decodeURIComponent(url.pathname).replace(/^\/+/, '')}),{abortSignal:AbortSignal.timeout(12000)});
  return photoBody(response);
 }
 const response=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:ref}),{abortSignal:AbortSignal.timeout(12000)});
 return photoBody(response);
}
async function readPhoto(ref){
 try{return await loadPhoto(ref);}catch(error){
  if(['NoSuchKey','NotFound'].includes(error.name)||error.$metadata?.httpStatusCode===404||error.response?.status===404)fail('Saved photo is unavailable. Capture a new face photo.');
  throw error;
 }
}
async function putPhoto(buffer,folder){
 if(!bucket())fail('Face storage is not configured.',503);
 const key=`supervisor-attendance/${folder}/${crypto.randomUUID()}.jpg`;
 await s3.send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:buffer,ContentType:'image/jpeg'}),{abortSignal:AbortSignal.timeout(12000)});
 return key;
}
async function discardPhoto(key){if(key)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:key}),{abortSignal:AbortSignal.timeout(12000)}).catch(()=>{});}
async function discardFace(site,faceId){if(faceId)await rekognition.send(new DeleteFacesCommand({CollectionId:collectionFor(site),FaceIds:[faceId]}),{abortSignal:AbortSignal.timeout(12000)}).catch(()=>{});}
async function detect(buffer,cityId){
 const result=await run(new DetectFacesCommand({Image:{Bytes:buffer},Attributes:['DEFAULT']}),cityId);
 const faces=result.FaceDetails||[];
 if(!faces.length)fail('No face found. Capture a clear photo.');
 if(faces.length>20)fail('Include at most 20 people in one group photo.');
 return faces;
}
async function indexFace(site,emp,buffer,cityId){
 await ensureCollection(site);
 const faces=await detect(buffer,cityId);
 if(faces.length!==1)fail('Store one employee’s face at a time.');
 if((faces[0].Confidence||0)<95||(faces[0].Quality?.Sharpness??0)<35)fail('Face is unclear. Capture a sharper photo.');
 const existing=await run(new SearchFacesByImageCommand({CollectionId:collectionFor(site),Image:{Bytes:buffer},MaxFaces:5,FaceMatchThreshold:threshold}),cityId);
 if((existing.FaceMatches||[]).some(m=>m.Face?.ExternalImageId!==`employee-${emp}`))fail('This face is already stored for another employee in this kothi.',409,'FACE_ALREADY_ASSIGNED');
 const result=await run(new IndexFacesCommand({CollectionId:collectionFor(site),Image:{Bytes:buffer},ExternalImageId:`employee-${emp}`,MaxFaces:1,QualityFilter:'AUTO',DetectionAttributes:['DEFAULT']}),cityId);
 const faceId=result.FaceRecords?.[0]?.Face?.FaceId;
 if(!faceId)fail('Face could not be registered. Capture a clearer photo.');
 return {faceId,collectionId:collectionFor(site)};
}
async function matchFaces(site,buffer,roster,group,cityId){
 const faces=await detect(buffer,cityId);
 if(!group&&faces.length!==1)fail('Individual attendance needs exactly one face.');
 const {width,height}=await sharp(buffer).metadata();
 const byFace=new Map(roster.map(p=>[p.face_id,p]));
 const results=new Array(faces.length);let next=0;
 // At most four concurrent indexed searches; never an employee-by-face comparison matrix.
 await Promise.all(Array.from({length:Math.min(4,faces.length)},async()=>{
  while(next<faces.length){const i=next++,face=faces[i];
   if((face.Confidence||0)<95||(face.Quality?.Sharpness??0)<25){results[i]={face:i+1,reason:'Face unclear'};continue;}
   const b=face.BoundingBox,left=Math.max(0,Math.floor(b.Left*width-width*0.03)),top=Math.max(0,Math.floor(b.Top*height-height*0.03));
   const right=Math.min(width,Math.ceil((b.Left+b.Width)*width+width*0.03)),bottom=Math.min(height,Math.ceil((b.Top+b.Height)*height+height*0.03));
   const crop=await sharp(buffer).extract({left,top,width:Math.max(1,right-left),height:Math.max(1,bottom-top)}).jpeg().toBuffer();
   const found=await run(new SearchFacesByImageCommand({CollectionId:collectionFor(site),Image:{Bytes:crop},MaxFaces:5,FaceMatchThreshold:threshold}),cityId);
   const matches=(found.FaceMatches||[]).filter(m=>typeof m.Similarity==='number'&&m.Similarity>=threshold&&m.Similarity<=100&&byFace.has(m.Face?.FaceId)&&m.Face.ExternalImageId===`employee-${byFace.get(m.Face.FaceId).emp_id}`).sort((a,b)=>b.Similarity-a.Similarity);
   if(!matches.length){results[i]={face:i+1,reason:'No matching employee in this kothi'};continue;}
   if(matches[1]&&matches[0].Similarity-matches[1].Similarity<3){results[i]={face:i+1,reason:'Match is ambiguous'};continue;}
   results[i]={face:i+1,employee:byFace.get(matches[0].Face.FaceId),similarity:matches[0].Similarity};
  }
 }));
 // One employee appearing twice in a photograph is not accepted automatically.
 const counts=new Map();for(const r of results)if(r.employee)counts.set(r.employee.emp_id,(counts.get(r.employee.emp_id)||0)+1);
 return results.map(r=>r.employee&&counts.get(r.employee.emp_id)>1?{face:r.face,reason:'Same employee appears more than once'}:r);
}
module.exports={normalize,readPhoto,putPhoto,discardPhoto,discardFace,indexFace,matchFaces,collectionFor,getPhotoUrl:getSignedS3Url};
