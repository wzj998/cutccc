import {videoDuration,videoPlacements} from './tracks.js';
export {videoDuration} from './tracks.js';
export function audioRange(voice, source) {
  return {start:voice.source_start ?? 0,end:voice.source_end ?? source?.duration ?? 0};
}
export function audioDuration(voice, source) {
  const r=audioRange(voice,source);return Math.max(0,r.end-r.start);
}
export function projectDuration(project) {
  let end=videoDuration(project);
  for(const voice of project.voiceovers || []) if(voice.detached||project.tracks!==undefined) {
    const source=project.sources.find(s=>s.id===voice.source_id);
    end=Math.max(end,Math.ceil((voice.start+audioDuration(voice,source))*30-1e-7)/30);
  }
  return end;
}
export function ownsAudioCaptions(project, clip) {
  return clip.audio_link && (project.voiceovers || []).some(v=>v.link_id===clip.audio_link&&v.source_id===clip.source_id);
}
export function detachClipAudio(project,index,linkId=globalThis.crypto.randomUUID()) {
  const p=structuredClone(project),clip=p.clips[index];
  const source=p.sources.find(s=>s.id===clip?.source_id);
  if(!source?.has_audio)throw new Error('此片段没有可分离的音轨。');
  if(ownsAudioCaptions(p,clip))throw new Error('此片段的音频已经分离。');
  p.voiceovers ||= [];
  if(p.voiceovers.length>=32)throw new Error('音频片段数量已达到上限。');
  const start=videoPlacements(p)[index].start;
  clip.muted=true;clip.audio_link=linkId;
  p.voiceovers.push({source_id:clip.source_id,start,source_start:clip.start,source_end:clip.end,
    volume:1,detached:true,link_id:linkId});
  return {project:p,index:p.voiceovers.length-1};
}
export function audioResizeContext(project,index,edge) {
  const voice=project.voiceovers?.[index],source=project.sources.find(s=>s.id===voice?.source_id);
  if(!voice||!source||!['start','end'].includes(edge))return null;
  const range=audioRange(voice,source);
  const minimum=edge==='start'?Math.max(-range.start,-voice.start):range.start+1/30-range.end;
  const maximum=edge==='start'?range.end-range.start-1/30:source.duration-range.end;
  return {projectId:project.id,index,edge,voice:{...voice},range,minimum,maximum};
}
export function resizedAudioClip(context,delta) {
  const bounded=Math.max(context.minimum,Math.min(context.maximum,delta));
  if(!bounded)return {...context.voice};
  const boundary=context.range[context.edge]+bounded;
  return {...context.voice,detached:true,
    start:context.voice.start+(context.edge==='start'?bounded:0),
    source_start:context.edge==='start'?boundary:context.range.start,
    source_end:context.edge==='end'?boundary:context.range.end};
}
export function removeAudioClip(project,index) {
  const p=structuredClone(project),voice=p.voiceovers[index];
  if(!voice)return p;
  const source=p.sources.find(s=>s.id===voice.source_id),r=audioRange(voice,source);
  if(!voice.link_id||!p.clips.some(c=>c.audio_link===voice.link_id)) {
    const copies=(p.subtitles[voice.source_id]||[]).filter(c=>c.timeline_offset===undefined&&c.start<r.end&&c.end>r.start)
      .map(c=>({...c,start:Math.max(c.start,r.start),end:Math.min(c.end,r.end),timeline_offset:voice.start-r.start}));
    p.subtitles[voice.source_id].push(...copies);
    p.subtitles[voice.source_id].sort((a,b)=>a.start-b.start||Number(a.timeline_offset!==undefined)-Number(b.timeline_offset!==undefined));
  }
  p.voiceovers.splice(index,1);return p;
}
