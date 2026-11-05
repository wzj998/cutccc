import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {startServer} from '../cutccc/node/server.js';
import {capture} from '../cutccc/node/processes.js';
import {speechOptions,placeSpeechAudio} from '../cutccc/web/speech-options.js';
import {projectDuration} from '../cutccc/web/audio-tracks.js';
import {validateEdit,validateVoiceovers} from '../cutccc/node/editing.js';
import {exportProfile} from '../cutccc/web/export-options.js';
import {insertSourceOnTrack} from '../cutccc/web/tracks.js';

const hasFFmpeg=spawnSync('ffmpeg',['-version'],{windowsHide:true}).status===0;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,{configure=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cutccc-speech-test-'));
  const app=await startServer({port:0,dataDir:path.join(root,'data'),modelsDir:path.join(root,'models')});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const request=async(route,method='GET',body)=>{
    const response=await fetch(app.url+route,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  };
  const model=path.join(root,'voice-model');await fs.mkdir(model);await fs.writeFile(path.join(model,'config.json'),'{}');
  app.studio.checkSpeechRuntime=async config=>{assert.equal(config.model_dir,model);return {ready:true};};
  if(configure){const configured=await request('/api/speech/settings','POST',{python:'python',model_dir:model});assert.equal(configured.status,200);}
  const project=await app.studio.createProject('Speech test');
  return {...app,root,model,request,project};
}
async function completed(f,id){
  for(let i=0;i<200;i++){const job=await f.studio.getJob(id);if(['completed','failed','cancelled'].includes(job.status))return job;await wait(30);}
  throw new Error('Speech job did not finish');
}

test('fresh installations report an unconfigured speech environment without failing the status endpoint',async t=>{
  const f=await fixture(t,{configure:false});
  const status=await f.request('/api/speech/status');assert.equal(status.status,200);assert.equal(status.body.ready,false);assert.equal(status.body.voices.length,4);
  const generation=await f.request(`/api/projects/${f.project.id}/speech`,'POST',{text:'Hello'});assert.equal(generation.status,422);
  assert.equal((await f.studio.listJobs(f.project.id)).length,0);assert.equal((await f.studio.getProject(f.project.id)).revision,f.project.revision);
});

test('speech options validate limits and do not accept arbitrary provider or path fields',()=>{
  assert.equal(speechOptions({text:'  Hello!  '}).text,'Hello!');
  for(const input of [{text:''},{text:'x'.repeat(1001)},{text:'x',speed:NaN},{text:'x',speed:3},{text:'x',voice:'missing'},{text:'x',language:'missing'},{text:'x',preview:'yes'},{text:'x',instruction:'x'.repeat(301)},{text:'x',path:'private'}])assert.throws(()=>speechOptions(input));
});

test('speech placement is independent, preserves original captions, and audio-only exports have a normal canvas',()=>{
  const source={id:'speech',kind:'audio',duration:2,width:0,height:0,has_audio:true};
  const original={sources:[],clips:[],subtitles:{},voiceovers:[]};
  const first=placeSpeechAudio(original,source,[{start:0,end:2,text:'Hello.'}],{position:3,subtitles:true});
  assert.deepEqual(original.voiceovers,[]);assert.equal(first.project.clips.length,0);assert.equal(projectDuration(first.project),5);
  assert.equal(first.project.subtitles.speech[0].timeline_offset,3);assert.equal(first.project.voiceovers[0].detached,true);
  const second=placeSpeechAudio(first.project,source,[{start:0,end:2,text:'Hello.'}],{position:0,subtitles:false});
  assert.equal(second.project.sources.length,1);assert.equal(second.project.subtitles.speech.length,1);assert.equal(second.project.voiceovers.length,2);
  validateEdit(second.project.sources,[],second.project.subtitles);validateVoiceovers(second.project.sources,[],second.project.voiceovers);
  assert.equal(exportProfile(source).width,1920);assert.equal(exportProfile(source).height,1080);
  assert.throws(()=>validateEdit([source],[{source_id:'speech',start:0,end:2}],{speech:[]}),/Audio/);
  assert.throws(()=>insertSourceOnTrack({...original,sources:[source]},'speech','video-main',0),/音频/);
});

test('speech settings are checked, persisted separately, and invalid settings retain the old configuration',async t=>{
  const f=await fixture(t),before=await f.studio.getProject(f.project.id);
  const status=await f.request('/api/speech/status');assert.equal(status.body.ready,true);assert.ok(status.body.voices.length>=4);
  f.studio.checkSpeechRuntime=async()=>{throw new Error('Missing runtime');};
  const failure=await f.request('/api/speech/settings','POST',{python:'python',model_dir:f.model});assert.equal(failure.status,422);
  assert.equal((await f.request('/api/speech/status')).body.ready,true);
  assert.deepEqual(await f.studio.getProject(before.id),before);
  for(const name of ['speech-options.js','speech-ui.js'])assert.equal((await fetch(f.url+'/static/'+name)).status,200);
  const html=await (await fetch(f.url+'/')).text();assert.match(html,/speechEntryBtn/);assert.match(html,/使用所选字幕/);
});

test('queued speech cancels without running inference and duplicate active requests are rejected',async t=>{
  const f=await fixture(t);let release;f.studio.queue=new Promise(resolve=>{release=resolve;});let calls=0;
  f.studio.runProcess=async()=>{calls++;};
  try{
    const first=await f.request(`/api/projects/${f.project.id}/speech`,'POST',{text:'Hello'});assert.equal(first.status,202);
    assert.equal((await f.request(`/api/projects/${f.project.id}/speech`,'POST',{text:'Hello'})).status,409);
    const cancel=await f.request(`/api/jobs/${first.body.id}/cancel`,'POST',{});assert.equal(cancel.body.status,'cancelled');
    release();await f.studio.queue;assert.equal(calls,0);assert.equal((await f.studio.getJob(first.body.id)).status,'cancelled');
    assert.equal((await f.request(`/api/jobs/${first.body.id}/cancel`,'POST',{})).status,409);
  }finally{release();}
});

test('running speech cancellation stops only its owned process and cannot be overwritten by worker completion',async t=>{
  const f=await fixture(t),run=f.studio.runProcess.bind(f.studio);
  f.studio.runProcess=(jid,_command,_args,folder)=>run(jid,process.execPath,['-e','setInterval(()=>{},1000)'],folder);
  const job=(await f.request(`/api/projects/${f.project.id}/speech`,'POST',{text:'Hello'})).body;
  for(let i=0;i<100&&!f.studio.jobProcesses.has(job.id);i++)await wait(20);
  assert.ok(f.studio.jobProcesses.has(job.id));
  const cancel=await f.request(`/api/jobs/${job.id}/cancel`,'POST',{});assert.equal(cancel.status,200);
  await f.studio.queue;assert.equal((await f.studio.getJob(job.id)).status,'cancelled');assert.equal(f.studio.processes.size,0);
});

test('generated WAV is previewable without project mutation; explicit import is versioned, reusable and rejects previews',{skip:!hasFFmpeg},async t=>{
  const f=await fixture(t),before=await f.studio.getProject(f.project.id),run=f.studio.runProcess.bind(f.studio);
  f.studio.runProcess=async(jid,command,args,folder,duration)=>{
    if(args[2]!=='cutccc.speech')return run(jid,command,args,folder,duration);
    const output=path.join(folder,'synthesis');await fs.mkdir(output);
    await capture('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','pcm_s16le',path.join(output,'raw.wav')]);
    const request=await f.studio.read(path.join(folder,'speech-request.json'));
    await f.studio.write(path.join(output,'result.json'),{duration:1,cues:[{start:0,end:1,text:request.text}]});
  };
  const submitted=await f.request(`/api/projects/${before.id}/speech`,'POST',{text:'Hello world.',speed:1.25});assert.equal(submitted.status,202);
  const job=await completed(f,submitted.body.id);assert.equal(job.status,'completed',job.message);assert.ok(Math.abs(job.result.duration-.8)<.08);
  assert.deepEqual(await f.studio.getProject(before.id),before);
  const audio=await fetch(f.url+job.result.audio_url);assert.equal(audio.status,200);assert.equal(audio.headers.get('content-type'),'audio/wav');assert.equal(Buffer.from(await audio.arrayBuffer()).subarray(0,4).toString(),'RIFF');
  const range=await fetch(f.url+job.result.audio_url,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
  assert.equal((await f.request(`/api/projects/${before.id}/speech/import`,'POST',{job_id:job.id,revision:999})).status,409);
  const imported=await f.request(`/api/projects/${before.id}/speech/import`,'POST',{job_id:job.id,revision:before.revision});assert.equal(imported.status,201);assert.equal(imported.body.source.kind,'audio');assert.equal(imported.body.project.voiceovers.length,0);assert.equal(imported.body.project.clips.length,0);
  const again=await f.request(`/api/projects/${before.id}/speech/import`,'POST',{job_id:job.id,revision:imported.body.project.revision});assert.equal(again.body.source.id,imported.body.source.id);assert.equal(again.body.project.revision,imported.body.project.revision);
  const placed=placeSpeechAudio(imported.body.project,imported.body.source,imported.body.cues,{subtitles:true});
  const p=placed.project;const saved=await f.request(`/api/projects/${p.id}`,'PATCH',{revision:p.revision,clips:p.clips,subtitles:p.subtitles,voiceovers:p.voiceovers});assert.equal(saved.status,200);
  const exported=await f.studio.submit(p.id,'export',{resolution:'480p'}),output=await completed(f,exported.id);assert.equal(output.status,'completed',output.message);
  const preview=await f.studio.submitSpeech(p.id,{text:'Preview.',preview:true}),ready=await completed(f,preview.id);assert.equal(ready.status,'completed');
  assert.equal((await f.request(`/api/projects/${p.id}/speech/import`,'POST',{job_id:preview.id,revision:saved.body.revision})).status,422);
  const other=await f.studio.createProject('Other');assert.equal((await f.request(`/api/projects/${other.id}/speech/import`,'POST',{job_id:job.id,revision:other.revision})).status,422);
});
