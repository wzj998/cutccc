import {SPEECH_VOICES,speechOptions} from './speech-options.js';
import {getTracks} from './tracks.js';

export function mountSpeechUI({api,getProject,getCaptions,getPosition,insert,openTab,beforePlay,toast}) {
  const $=id=>document.getElementById(id);
  let status=null,job=null,full=null,fullKey=null,jobKey=null,projectId=null,checking=false,requesting=false,pollTimer=null,polling=false;
  const active=()=>requesting||['queued','running'].includes(job?.status);
  const options=()=>({text:$('speechText').value,voice:document.querySelector('input[name=speechVoice]:checked')?.value||'warm',language:$('speechLanguage').value,speed:Number($('speechSpeed').value),instruction:$('speechInstruction').value});
  const key=()=>JSON.stringify(options());
  const displayMessage=(message,error=false)=>{$('speechHint').textContent=message;$('speechHint').classList.toggle('speech-error',error);};
  function update() {
    const p=getProject();
    if(p?.id!==projectId){
      projectId=p?.id||null;job=null;full=null;fullKey=null;jobKey=null;requesting=false;
      $('speechResult').hidden=true;$('speechPreviewAudio').pause();$('speechPreviewAudio').hidden=true;
      clearTimeout(pollTimer);
    }
    const length=[...$('speechText').value].length;
    $('speechTextCount').textContent=`${length} / 1000`;
    $('speechTextCount').parentElement.classList.toggle('over-limit',length>1000);
    $('speechSpeedValue').textContent=Number($('speechSpeed').value).toFixed(2)+'×';
    $('speechUseCaptions').disabled=!getCaptions().length;
    $('captionToSpeechBtn').disabled=!getCaptions().length;
    $('speechGenerateBtn').disabled=!p||!status?.ready||active()||checking||!$('speechText').value.trim()||length>1000;
    $('speechPreviewBtn').disabled=!p||!status?.ready||active()||checking;
    $('speechGenerateBtn').textContent=['queued','running'].includes(job?.status)?'正在生成…':full?'♫ 重新生成配音':'♫ 生成配音';
    $('speechSaveSettings').disabled=checking||active();
    $('speechTask').hidden=!job;
    $('speechTaskMessage').textContent=job?.message||'';
    $('speechTaskProgress').value=job?.progress||0;
    $('speechTaskProgress').hidden=!['queued','running'].includes(job?.status);
    $('speechCancelBtn').hidden=!['queued','running'].includes(job?.status);$('speechCancelBtn').disabled=requesting;
    const changed=!!full&&fullKey!==key();
    $('speechChangedHint').hidden=!changed;
    $('speechInsertBtn').disabled=!full||changed||active()||!p||full.project_id!==p.id;
    const tracks=p?getTracks(p).filter(t=>t.type==='audio'):[];
    const current=$('speechAudioTrack').value;
    const existing=[...$('speechAudioTrack').options].slice(1).map(o=>o.value).join(',');
    if(existing!==tracks.map(t=>t.id).join(',')){
      $('speechAudioTrack').replaceChildren(new Option('自动选择音频轨道',''),...tracks.map(t=>new Option(t.name,t.id)));
      if(tracks.some(t=>t.id===current))$('speechAudioTrack').value=current;
    }
    if(!p)displayMessage('请先新建或打开项目，再生成配音。');
    else if(status&&!status.ready)displayMessage(status.message);
  }
  async function refreshStatus() {
    try{
      status=await api('/api/speech/status');
      $('speechPython').value=status.config.python;$('speechModelDir').value=status.config.model_dir;
      displayMessage(status.message);
    }catch(error){status={ready:false};displayMessage(error.message,true);}
    update();
  }
  function open(useCaptions=false) {
    openTab('speech');
    if(useCaptions){
      const entries=getCaptions();
      if(entries.length){$('speechText').value=entries.map(c=>c.text).join('\n');$('speechAddCaptions').checked=false;
        $('speechInsertPosition').value=Number(entries[0].start.toFixed(2));}
    }else $('speechInsertPosition').value=Number(getPosition().toFixed(2));
    update();$('speechText').focus({preventScroll:true});
    if(!status?.ready){$('speechSettings').open=true;void refreshStatus();}
  }
  function finishJob(next,force=false) {
    if(next.project_id!==getProject()?.id)return;
    if(!force&&job?.id===next.id&&job.status===next.status&&['completed','failed','cancelled'].includes(next.status)){update();return;}
    job=next;
    if(next.status==='completed'){
      if(next.result.preview){
        const player=$('speechPreviewAudio');player.hidden=false;player.preload='metadata';player.src=next.result.audio_url;
        player.play().catch(()=>displayMessage('试听已生成，点击播放器播放。'));
      }else{
        full=next;fullKey=jobKey;$('speechResult').hidden=false;
        $('speechResultAudio').src=next.result.audio_url;
        $('speechDuration').textContent=next.result.duration.toFixed(2)+' 秒';
        $('speechDownload').href=next.result.audio_url;
      }
      displayMessage(next.result.preview?'音色试听已生成。':'配音已生成。试听确认后，再添加到时间轴。');
    }else if(next.status==='failed')displayMessage(next.message,true);
    else if(next.status==='cancelled')displayMessage('已取消，修改文字或音色后可重新生成。');
    update();
  }
  async function poll() {
    if(polling||!job||!['queued','running'].includes(job.status))return;
    polling=true;const id=job.id;
    try{
      const next=await api(`/api/jobs/${id}`);
      if(job?.id!==id||next.project_id!==getProject()?.id)return;
      finishJob(next);
    }catch(error){displayMessage('暂时无法读取生成进度，正在重试：'+error.message,true);}
    finally{polling=false;if(job?.id===id&&['queued','running'].includes(job.status))pollTimer=setTimeout(poll,1000);}
  }
  async function generate(preview) {
    if(active()||!getProject())return;
    const p=getProject(),input=options();
    if(preview&&!input.text.trim())input.text='你好，欢迎使用本地剪辑工作台。让文字成为自然的声音。';
    try{speechOptions({...input,preview});}catch(error){displayMessage(error.message,true);return;}
    requesting=true;jobKey=key();displayMessage(preview?'正在准备音色试听…':'正在提交配音任务…');update();
    try{
      const result=await api(`/api/projects/${p.id}/speech`,'POST',{...input,preview});
      if(getProject()?.id!==p.id)return;
      job=result;displayMessage(preview?'试听正在生成，首次加载模型需要一点时间。':'配音正在生成，期间可以继续剪辑。');
      pollTimer=setTimeout(poll,300);
    }catch(error){displayMessage(error.message,true);}
    finally{requesting=false;update();}
  }
  async function addToTimeline() {
    if(!full||fullKey!==key()||full.project_id!==getProject()?.id)return;
    const position=Number($('speechInsertPosition').value);
    if(!Number.isFinite(position)||position<0){displayMessage('请设置有效的添加位置。',true);return;}
    requesting=true;update();
    try{
      await insert(full,{position,trackId:$('speechAudioTrack').value||undefined,subtitles:$('speechAddCaptions').checked});
      displayMessage('配音已添加到音频轨道，可单独移动、裁剪或撤销。');
      toast('配音已添加到时间轴。');
    }catch(error){displayMessage(error.message,true);}
    finally{requesting=false;update();}
  }
  $('speechVoices').replaceChildren(...SPEECH_VOICES.map((voice,index)=>{
    const label=document.createElement('label');label.className='speech-voice';label.title=voice.description;
    const radio=document.createElement('input');radio.type='radio';radio.name='speechVoice';radio.value=voice.id;radio.checked=index===0;
    const content=document.createElement('span'),name=document.createElement('strong'),description=document.createElement('small');
    name.textContent=voice.name;description.textContent=voice.tag;content.append(name,description);label.append(radio,content);radio.onchange=update;return label;
  }));
  $('speechEntryBtn').onclick=()=>open();$('speechUseCaptions').onclick=()=>open(true);$('captionToSpeechBtn').onclick=()=>open(true);
  $('speechText').oninput=update;$('speechInstruction').oninput=update;$('speechLanguage').onchange=update;$('speechSpeed').oninput=update;
  $('speechResetSpeed').onclick=()=>{$('speechSpeed').value=1;update();};
  $('speechUsePlayhead').onclick=()=>{$('speechInsertPosition').value=Number(getPosition().toFixed(2));};
  $('speechPreviewBtn').onclick=()=>void generate(true);$('speechGenerateBtn').onclick=()=>void generate(false);
  $('speechInsertBtn').onclick=()=>void addToTimeline();
  $('speechCancelBtn').onclick=async()=>{
    if(!job||!active())return;
    try{finishJob(await api(`/api/jobs/${job.id}/cancel`,'POST',{}));clearTimeout(pollTimer);}catch(error){displayMessage(error.message,true);}
  };
  $('speechSaveSettings').onclick=async()=>{
    checking=true;$('speechSettingsStatus').textContent='正在检查 Python、模型和 GPU…';update();
    try{
      status=await api('/api/speech/settings','POST',{python:$('speechPython').value,model_dir:$('speechModelDir').value});
      $('speechSettingsStatus').textContent='检查通过。语音合成在本机离线运行。';displayMessage(status.message);
    }catch(error){$('speechSettingsStatus').textContent=error.message;}
    finally{checking=false;update();}
  };
  for(const player of [$('speechPreviewAudio'),$('speechResultAudio')])player.onplay=()=>{
    beforePlay();for(const other of [$('speechPreviewAudio'),$('speechResultAudio')])if(other!==player)other.pause();
  };
  void refreshStatus();
  return {update,open,refreshStatus,openJob(next){
    if(!next||next.kind!=='speech'||next.project_id!==getProject()?.id)return;
    if(active()&&next.id!==job?.id){toast('请等待当前语音任务完成或先取消。',true);return;}
    openTab('speech');update();
    $('speechText').value=next.speech.text;$('speechLanguage').value=next.speech.language;
    $('speechSpeed').value=next.speech.speed;$('speechInstruction').value=next.speech.instruction;
    for(const radio of document.querySelectorAll('input[name=speechVoice]'))radio.checked=radio.value===next.speech.voice;
    $('speechInsertPosition').value=Number(getPosition().toFixed(2));
    jobKey=key();finishJob(next,true);
    if(['queued','running'].includes(next.status)){clearTimeout(pollTimer);pollTimer=setTimeout(poll,300);}
  },syncJobs(jobs){
    if(job){const next=jobs.find(j=>j.id===job.id);if(next&&next.status!==job.status)finishJob(next);}
  }};
}
