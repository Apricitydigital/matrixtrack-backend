'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const dir=path.resolve(__dirname,'../tests');
const files=fs.readdirSync(dir).filter(file=>/\.(test|integration)\.js$/.test(file)).sort().map(file=>path.join(dir,file));
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{stdio:'inherit',windowsHide:true});
if(result.error)console.error(result.error.message);process.exitCode=result.status??1;
