export const DEFAULT_TRACKS=Object.freeze({video:'video-main',audio:'audio-main',subtitle:'subtitle-main'});
export const trackId=(item,type)=>item.track_id||DEFAULT_TRACKS[type];
const clipFrames=c=>{const n=(c.end-c.start)*30,f=Math.floor(n);return Math.max(1,n-f===.5?f+f%2:Math.round(n));};
export const clipDuration=c=>clipFrames(c)/30;
export function getTracks(project) {
  if(!project)return [];
  const result=(project.tracks||[]).map(t=>({...t}));
  const add=type=>{const id=DEFAULT_TRACKS[type];if(!result.some(t=>t.id===id))result.push({id,type,name:{video:'视频1',audio:'音频1',subtitle:'字幕1'}[type]});};
  if(project.tracks===undefined){add('video');add('subtitle');if(project.voiceovers?.length)add('audio');}
  if(project.clips.some(c=>!c.track_id))add('video');
  if(project.voiceovers?.some(v=>!v.track_id))add('audio');
  if(Object.values(project.subtitles||{}).some(list=>list.some(c=>!c.track_id)))add('subtitle');
  return result;
}
export function videoPlacements(project) {
  let frames=0;
  return project.clips.map((clip,index)=>{
    const start=clip.timeline_start??frames/30,length=clipDuration(clip);
    frames+=clipFrames(clip);
    return {clip,index,start,end:start+length,trackId:trackId(clip,'video')};
  });
}
export const videoDuration=project=>Math.ceil(Math.max(0,...videoPlacements(project).map(p=>p.end))*30-1e-7)/30;
export function videoLayerOrder(project) {
  const order=getTracks(project).filter(t=>t.type==='video').map(t=>t.id);
  return videoPlacements(project).sort((a,b)=>order.indexOf(b.trackId)-order.indexOf(a.trackId)||a.index-b.index);
}
export function videoAtTime(project,time) {
  return videoLayerOrder(project).filter(p=>time>=p.start-1e-8&&time<p.end-1e-8).at(-1)||null;
}
export const hasFreeVideo=project=>project.clips.some(c=>c.timeline_start!==undefined||trackId(c,'video')!==DEFAULT_TRACKS.video);
export function addTrack(project,type,id=globalThis.crypto.randomUUID()) {
  if(!['video','audio','subtitle'].includes(type))throw new Error('未知轨道类型。');
  const p=structuredClone(project);p.tracks=getTracks(p);
  if(p.tracks.length>=64)throw new Error('轨道数量已达到上限。');
  const prefix={video:'视频',audio:'音频',subtitle:'字幕'}[type];let number=1;
  while(p.tracks.some(t=>t.name===prefix+number))number++;
  const track={id,type,name:prefix+number},first=p.tracks.findIndex(t=>t.type==='video');
  if(type==='video'&&first>=0)p.tracks.splice(first,0,track);else p.tracks.push(track);
  return {project:p,track};
}
export function trackItems(project,id) {
  return project.clips.filter(c=>trackId(c,'video')===id).length+
    (project.voiceovers||[]).filter(v=>trackId(v,'audio')===id).length+
    Object.values(project.subtitles||{}).reduce((n,list)=>n+list.filter(c=>trackId(c,'subtitle')===id).length,0);
}
export function removeTrack(project,id) {
  const p=structuredClone(project);p.tracks=getTracks(p).filter(t=>t.id!==id);
  p.clips=p.clips.filter(c=>trackId(c,'video')!==id);
  p.voiceovers=(p.voiceovers||[]).filter(v=>trackId(v,'audio')!==id);
  for(const [sid,list] of Object.entries(p.subtitles))p.subtitles[sid]=list.filter(c=>trackId(c,'subtitle')!==id);
  return p;
}
export function materializeVideoPositions(project) {
  for(const p of videoPlacements(project))p.clip.timeline_start=p.start;
}
export function moveVideoToTrack(project,index,id,start) {
  const p=structuredClone(project);p.tracks=getTracks(p);
  if(!p.tracks.some(t=>t.id===id&&t.type==='video'))throw new Error('视频片段只能拖入视频轨道。');
  const clip=p.clips[index];if(!clip)throw new Error('片段已改变，请重新选择。');
  materializeVideoPositions(p);clip.track_id=id;clip.timeline_start=Math.max(0,Math.round(start*30)/30);
  if(clip.timeline_start+clipDuration(clip)>86400)throw new Error('片段超出时间轴范围。');
  return p;
}
export function insertSourceOnTrack(project,sourceId,id,start) {
  const p=structuredClone(project),source=p.sources.find(s=>s.id===sourceId),track=getTracks(p).find(t=>t.id===id);
  if(!source||!track)throw new Error('素材或轨道已改变。');
  p.tracks=getTracks(p);start=Math.max(0,Math.round(start*30)/30);
  if(start+source.duration>86400)throw new Error('素材超出时间轴范围。');
  if(track.type==='video') {
    if(p.clips.length>=64)throw new Error('视频片段数量已达到上限。');
    materializeVideoPositions(p);p.clips.push({source_id:sourceId,start:0,end:source.duration,timeline_start:start,track_id:id});
    return {project:p,kind:'clip',index:p.clips.length-1};
  }
  if(track.type==='audio'&&source.has_audio) {
    p.voiceovers||=[];if(p.voiceovers.length>=32)throw new Error('音频片段数量已达到上限。');
    p.voiceovers.push({source_id:sourceId,start,source_start:0,source_end:source.duration,detached:true,volume:1,track_id:id});
    return {project:p,kind:'voice',index:p.voiceovers.length-1};
  }
  throw new Error('请将素材拖入视频或音频轨道；字幕轨道仅接收字幕。');
}
