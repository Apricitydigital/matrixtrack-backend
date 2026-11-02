'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const folders=['config','controllers','middleware','routes','utils','scripts','tests','db'];
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
const sources=[path.join(root,'app.js'),...folders.flatMap(folder=>files(path.join(root,folder))).filter(file=>/\.(js|cjs)$/.test(file))];
let failure=false;
for(const file of sources){
 const content=fs.readFileSync(file,'utf8');
 for(const match of (file.includes(path.sep+'tests'+path.sep)?[]:content.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g))){
  try{require.resolve(path.resolve(path.dirname(file),match[1]));}catch(error){console.error(path.relative(root,file)+': missing '+match[1]);failure=true;}
 }
 const result=cp.spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
 if(result.status!==0){console.error(result.stderr||result.error?.message);failure=true;}
}
if(failure)process.exitCode=1;else console.log(`PASS: ${sources.length} JavaScript files parse and their relative imports resolve.`);
