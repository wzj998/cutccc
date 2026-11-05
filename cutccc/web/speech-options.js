import {getTracks} from './tracks.js';
export const SPEECH_VOICES = Object.freeze([
  {id:'warm',name:'温柔女声',tag:'亲切 · 舒缓',description:'温暖柔和，适合生活记录和日常讲述。',instruction:'成年女性，声音温暖柔和、亲切自然，发音清晰，语速适中，有自然停顿，不要过度气声。'},
  {id:'clear',name:'清晰男声',tag:'沉稳 · 清晰',description:'清楚利落，适合讲解和知识分享。',instruction:'成年男性，中低音，沉稳清晰、自然友好，发音标准，轻微强调重点，不要夸张播音腔。'},
  {id:'documentary',name:'纪实旁白',tag:'自然 · 克制',description:'平实、有呼吸感，适合旅行和影像旁白。',instruction:'成年女性，自然纪实旁白，声音干净，有真实讲述的呼吸和停顿，语气平实克制，重点词略强调，不要机器人或新闻播音腔。'},
  {id:'bright',name:'活力讲解',tag:'明快 · 有表现力',description:'节奏轻快，适合开场和产品介绍。',instruction:'成年男性，声音明亮有活力，语气轻松自信，讲解清楚，节奏明快但不要喊叫或夸张。'},
]);
export const SPEECH_LANGUAGES = ['Auto','Chinese','English'];
export function speechOptions(input = {}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('语音参数格式不正确。');
  const allowed=['text','voice','language','speed','instruction','preview'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))throw new Error('包含未知的语音参数。');
  const text=input.text,voice=input.voice??'warm',language=input.language??'Auto',speed=input.speed??1,instruction=input.instruction??'',preview=input.preview??false;
  if(typeof text!=='string'||!text.trim()||[...text].length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new Error('请输入1–1000字的配音文字。');
  if(!SPEECH_VOICES.some(v=>v.id===voice))throw new Error('请选择有效的音色。');
  if(!SPEECH_LANGUAGES.includes(language))throw new Error('请选择有效的语言。');
  if(typeof speed!=='number'||!Number.isFinite(speed)||speed<.5||speed>2)throw new Error('语速范围为0.5–2倍。');
  if(typeof instruction!=='string'||[...instruction].length>300)throw new Error('风格描述不能超过300字。');
  if(typeof preview!=='boolean')throw new Error('试听参数必须是布尔值。');
  return {text:text.trim(),voice,language,speed,instruction:instruction.trim(),preview};
}

// Adding a generated asset stays outside edit history; the audio placement itself is undoable.
export function placeSpeechAudio(project, source, cues, {position=0,trackId,subtitles=false} = {}) {
  if(!Number.isFinite(position)||position<0||position+source.duration>86400)throw new Error('配音位置超出时间轴范围。');
  if(!source.has_audio||source.kind!=='audio'||!Number.isFinite(source.duration)||source.duration<1/30)throw new Error('配音音频无效。');
  const p=structuredClone(project);
  if(!p.sources.some(s=>s.id===source.id))p.sources.push(structuredClone(source));
  p.voiceovers||=[];
  if(p.voiceovers.length>=32)throw new Error('音频片段数量已达到上限。');
  if(trackId&&!getTracks(p).some(t=>t.id===trackId&&t.type==='audio'))throw new Error('请选择音频轨道。');
  p.subtitles[source.id]||=[];
  const at=Math.round(position*30)/30;
  if(at+source.duration>86400)throw new Error('配音位置超出时间轴范围。');
  p.voiceovers.push({source_id:source.id,start:at,source_start:0,source_end:source.duration,detached:true,volume:1,...(trackId?{track_id:trackId}:{})});
  if(subtitles)for(const cue of cues){
    if(typeof cue.text!=='string'||!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.end>source.duration+.001||cue.end<=cue.start)throw new Error('生成字幕的时间无效。');
    if(p.subtitles[source.id].length>=10000)throw new Error('字幕数量已达到上限。');
    // Each placement gets its own display occurrence, including repeated uses of one audio asset.
    p.subtitles[source.id].push({...cue,timeline_offset:at});
  }
  return {project:p,index:p.voiceovers.length-1};
}
