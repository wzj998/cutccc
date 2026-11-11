import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {pickLocalFiles,localPickerCommand} from '../cutccc/node/local-files.js';

test('native file chooser uses a fixed STA dialog and passes file names as JSON, never as commands',async()=>{
  const a=path.join(os.tmpdir(),'原片 with spaces & symbols.mp4');
  let invocation;
  const result=await pickLocalFiles({platform:'win32',run:async(...args)=>{invocation=args;return {stdout:JSON.stringify([a,a]),stderr:''};}});
  assert.deepEqual(result,{paths:[a],cancelled:false});
  assert.equal(invocation[0],'powershell.exe');
  assert.ok(invocation[1].includes('-STA'));assert.equal(invocation[2].windowsHide,true);
  const script=Buffer.from(invocation[1].at(-1),'base64').toString('utf16le');
  assert.ok(script.includes('System.Windows.Forms.OpenFileDialog'));
  assert.ok(!script.includes(a));
  assert.deepEqual(await pickLocalFiles({platform:'win32',run:async()=>({stdout:'[]'})}),{paths:[],cancelled:true});
  await assert.rejects(pickLocalFiles({platform:'win32',run:async()=>({stdout:'["relative.mp4"]'})}),/Invalid local file selection/);
  await assert.rejects(pickLocalFiles({platform:'win32',run:async()=>({stdout:'not json'})}),/无法读取/);
  assert.throws(()=>localPickerCommand('linux'),error=>error.status===501);
});
