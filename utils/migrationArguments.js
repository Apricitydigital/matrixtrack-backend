'use strict';
function validateMigrationArguments(args,{flags=['--apply','--preview-names','--rollback','--compatible-code-deployed','--maintenance-confirmed','--include-self-attendance-rename','--payroll-export-verified','--help']}={}){
 const allowed=new Set(flags),values=new Set(['--env-file','--expected-host','--expected-database','--report']),seen=new Set();
 for(const arg of args){
  if(typeof arg!=='string'||!arg.startsWith('--'))throw Error('Unknown migration argument; use --help');
  const at=arg.indexOf('='),name=at<0?arg:arg.slice(0,at);
  if(!allowed.has(name)&&!values.has(name))throw Error('Unknown migration option: '+name);
  if(seen.has(name))throw Error('Duplicate migration option: '+name);seen.add(name);
  if(allowed.has(name)&&at>=0)throw Error('Invalid value for flag '+name);
  if(values.has(name)&&(at<0||!arg.slice(at+1).trim()))throw Error(name+' requires a value using =');
 }
}
module.exports={validateMigrationArguments};
