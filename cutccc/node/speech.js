import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {APIError} from './editing.js';
import {capture,stopProcess} from './processes.js';
import {inferenceEnvironment} from './inference-environment.js';
import {SPEECH_VOICES,speechOptions} from '../web/speech-options.js';

const uuid=()=>randomUUID().replaceAll('-','');
const now=()=>Date.now()/1000;
const configPath=s=>path.join(s.root,'speech-settings.json');
export async function speechConfiguration(studio) {
  let saved={};
  try{saved=await studio.read(configPath(studio));}catch(error){if(error.code!=='ENOENT')throw error;}
  const python=process.env.CUTCCC_TTS_PYTHON||saved.python||studio.python;
  const model_dir=process.env.CUTCCC_TTS_MODELS_DIR||saved.model_dir||path.join(studio.models,'Qwen3-TTS-12Hz-1.7B-VoiceDesign');
  return {python,model_dir,checked:saved.checked===true&&saved.python===python&&saved.model_dir===model_dir};
}
export async function checkSpeechRuntime(config) {
  const result=await capture(config.python,['-u','-m','cutccc.speech','--models-dir',config.model_dir,'--check'],{env:inferenceEnvironment(),timeout:60000,maxBytes:1024*1024});
  const check=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  if(check.ready!==true)throw new APIError('本地语音环境尚未就绪。');
  return check;
}
export async function speechStatus(studio) {
  const config=await speechConfiguration(studio);
  let exists=false;
  try{exists=(await fs.stat(path.join(config.model_dir,'config.json'))).isFile();}catch{}
  return {provider:'Qwen3-TTS VoiceDesign',ready:exists&&config.checked,config:{python:config.python,model_dir:config.model_dir},voices:SPEECH_VOICES,
    message:exists&&config.checked?'本地语音环境已就绪':'请在“本地语音设置”中配置并检查语音环境。'};
}
export async function saveSpeechConfiguration(studio,input) {
  if(!input||Object.keys(input).some(k=>!['python','model_dir'].includes(k))||typeof input.python!=='string'||!input.python.trim()||input.python.length>1024||typeof input.model_dir!=='string'||!path.isAbsolute(input.model_dir)||input.model_dir.length>1024)
    throw new APIError('请填写有效的 Python 可执行文件和模型目录。',422);
  const config={python:input.python.trim(),model_dir:path.resolve(input.model_dir)};
  if((process.env.CUTCCC_TTS_PYTHON&&process.env.CUTCCC_TTS_PYTHON!==config.python)||(process.env.CUTCCC_TTS_MODELS_DIR&&path.resolve(process.env.CUTCCC_TTS_MODELS_DIR)!==config.model_dir))throw new APIError('服务已通过环境变量指定语音环境，请修改启动配置后重启服务，或使用当前配置。',422);
  if((config.python.includes('/')||config.python.includes('\\'))&&!path.isAbsolute(config.python))throw new APIError('Python 可执行文件请使用绝对路径。',422);
  try{await studio.checkSpeechRuntime(config);}catch(error){throw new APIError('语音环境检查失败：'+error.message.slice(-900),422);}
  await studio.write(configPath(studio),{...config,checked:true});
  return speechStatus(studio);
}
export async function submitSpeech(studio,id,input) {
  let options;
  try{options=speechOptions(input);}catch(error){throw new APIError(error.message,422);}
  if(options.preview)options.text=[...options.text].slice(0,50).join('');
  return studio.exclusive(async()=>{
    if(studio.closed)throw new APIError('服务正在关闭。',503);
    await studio.getProject(id);
    const status=await speechStatus(studio);
    if(!status.ready)throw new APIError(status.message,422);
    if((await studio.listJobs(id)).some(j=>j.kind==='speech'&&['queued','running'].includes(j.status)))throw new APIError('当前项目正在生成语音，请等待完成或取消后重试。',409);
    const jid=uuid(),job={id:jid,project_id:id,kind:'speech',source_id:null,status:'queued',progress:0,message:'等待生成语音',created_at:now(),speech:options};
    await fs.mkdir(studio.jobDir(jid));await studio.write(studio.jobDir(jid,'job.json'),job);
    const config=await speechConfiguration(studio);
    studio.queue=studio.queue.then(()=>workSpeech(studio,jid,config)).catch(error=>console.error('cutccc speech:',error.message));
    return job;
  });
}
export async function probeSpeechAudio(file) {
  const data=JSON.parse((await capture('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
  const audio=data.streams?.find(s=>s.codec_type==='audio'),duration=Number(data.format?.duration);
  if(!audio||!Number.isFinite(duration)||duration<1/30||duration>1800)throw new APIError('生成的语音时长或格式无效。');
  return {duration,sample_rate:Number(audio.sample_rate)};
}
async function workSpeech(studio,jid,config) {
  try{
    let job=await studio.getJob(jid);
    if(studio.closed||job.status==='cancelled')return;
    job=await studio.updateJob(jid,{status:'running',started_at:now(),message:'正在加载本地语音模型',progress:3});
    if(job.status==='cancelled')return;
    const folder=studio.jobDir(jid),voice=SPEECH_VOICES.find(v=>v.id===job.speech.voice);
    await studio.write(path.join(folder,'speech-request.json'),{text:job.speech.text,language:job.speech.language,instruction:voice.instruction+(job.speech.instruction?'\n'+job.speech.instruction:'')});
    await studio.runProcess(jid,config.python,['-u','-m','cutccc.speech','--models-dir',config.model_dir,'--request',path.join(folder,'speech-request.json'),'--output',path.join(folder,'synthesis')],folder);
    if((await studio.getJob(jid)).status==='cancelled')return;
    const generated=await studio.read(path.join(folder,'synthesis','result.json'));
    if(!Number.isFinite(generated.duration)||generated.duration<=0||!Array.isArray(generated.cues))throw new APIError('语音模型输出无效。');
    await studio.updateJob(jid,{progress:90,message:'正在处理语速并检查音频'});
    const filters=[`atempo=${job.speech.speed}`,...(job.speech.preview?['atrim=duration=5']:[]),'alimiter=limit=0.98:level=false:latency=true'];
    await studio.runProcess(jid,'ffmpeg',['-nostdin','-v','error','-i',path.join(folder,'synthesis','raw.wav'),'-af',filters.join(','),'-c:a','pcm_s16le','-y',path.join(folder,'speech.wav')],folder);
    if((await studio.getJob(jid)).status==='cancelled')return;
    const metadata=await probeSpeechAudio(path.join(folder,'speech.wav'));
    const cues=generated.cues.map(c=>({start:Math.max(0,c.start/job.speech.speed),end:Math.min(metadata.duration,c.end/job.speech.speed),text:c.text})).filter(c=>c.end>c.start);
    if(cues.some(c=>!Number.isFinite(c.start)||!Number.isFinite(c.end)||typeof c.text!=='string'||!c.text.trim()))throw new APIError('生成语音的分句时间无效。');
    await studio.write(path.join(folder,'speech-result.json'),{...metadata,cues});
    await studio.updateJob(jid,{status:'completed',progress:100,message:job.speech.preview?'试听已生成':'配音已生成，请试听后添加到时间轴',finished_at:now(),
      result:{...metadata,cues,preview:job.speech.preview,audio_url:`/api/jobs/${jid}/audio`,provider:'Qwen3-TTS VoiceDesign'}});
  }catch(error){
    const current=await studio.getJob(jid);
    if(current.status==='cancelled')return;
    await studio.updateJob(jid,{status:'failed',message:error.message.slice(-900),finished_at:now()});
  }
}
export async function speechAudioFile(studio,jid) {
  const job=await studio.getJob(jid);
  if(job.kind!=='speech'||job.status!=='completed')throw new APIError('语音尚未生成完成。',409);
  return studio.jobDir(jid,'speech.wav');
}
export async function importSpeechResult(studio,id,jid,revision) {
  return studio.exclusive(async()=>{
    const p=await studio.getProject(id),job=await studio.getJob(jid);
    if(p.revision!==revision)throw new APIError('项目已更新，请保存或重新载入后添加语音。',409);
    if(job.project_id!==id||job.kind!=='speech'||job.status!=='completed'||job.speech.preview)throw new APIError('请选择当前项目中生成完成的完整配音。',422);
    let source=p.sources.find(s=>s.speech_job===jid);
    if(!source){
      if(p.sources.length>=256)throw new APIError('项目素材数量已达到上限。');
      const sid=uuid();
      source={id:sid,name:'配音 · '+job.speech.text.replace(/\s+/g,' ').slice(0,22)+'.wav',file:sid+'.wav',kind:'audio',width:0,height:0,fps:0,duration:job.result.duration,has_audio:true,subtitle_version:0,speech_job:jid};
      const target=studio.projectDir(id,'media',source.file);
      await fs.copyFile(studio.jobDir(jid,'speech.wav'),target,fs.constants.COPYFILE_EXCL);
      try{p.sources.push(source);p.subtitles[source.id]=[];await studio.save(p);}catch(error){await fs.unlink(target).catch(()=>{});throw error;}
    }
    return {project:p,source,cues:job.result.cues};
  });
}
export async function cancelSpeech(studio,jid) {
  const job=await studio.getJob(jid);
  if(job.kind!=='speech'||!['queued','running'].includes(job.status))throw new APIError('此语音任务当前无法取消。',409);
  studio.cancelledSpeech.add(jid);
  const result=await studio.updateJob(jid,{status:'cancelled',message:'已取消语音生成',finished_at:now()});
  await stopProcess(studio.jobProcesses.get(jid));
  return result;
}
