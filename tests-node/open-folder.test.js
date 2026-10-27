import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {openFolder} from '../cutccc/node/open-folder.js';
test('file manager launch keeps paths as one argument and shows the requested window',async()=>{
 const folder=path.join(os.tmpdir(),'export with spaces & symbols');let args,unref=false;
 await openFolder(folder,{platform:'win32',spawnProcess:(...values)=>{
  args=values;const child=new EventEmitter();child.unref=()=>{unref=true;};queueMicrotask(()=>child.emit('spawn'));return child;
 }});
 assert.deepEqual(args,['explorer.exe',[folder],{detached:true,stdio:'ignore',windowsHide:false}]);
 assert.equal(unref,true);
 await assert.rejects(openFolder(folder,{platform:'unknown'}),/not supported/);
 await assert.rejects(openFolder(folder,{spawnProcess:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',new Error('launch failed')));return child;}}),/launch failed/);
});
