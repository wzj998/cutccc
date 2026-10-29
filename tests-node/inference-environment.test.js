import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {inferenceEnvironment,packageRoot} from '../cutccc/node/inference-environment.js';

test('inference environment prepends bundled Python sources and retains custom paths',()=>{
  const original={PYTHONPATH:'custom-path',OTHER:'kept'};
  const env=inferenceEnvironment(original);
  assert.equal(env.PYTHONPATH,packageRoot+path.delimiter+'custom-path');
  assert.equal(env.OTHER,'kept');assert.equal(env.PYTHONUTF8,'1');
  assert.equal(original.PYTHONPATH,'custom-path');
});

const hasPython=spawnSync('python',['--version'],{windowsHide:true}).status===0;
test('bundled Python CLI works outside the repository without a site-installed cutccc',{skip:!hasPython},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cutccc-npm-python-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const result=spawnSync('python',['-S','-m','cutccc','transcribe','--help'],{cwd:root,env:inferenceEnvironment({PATH:process.env.PATH}),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/--language/);
});
