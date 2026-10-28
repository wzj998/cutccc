import {validateStyle} from './subtitle-style.js';
import {audioRange,audioDuration,projectDuration,videoDuration} from './audio-tracks.js';
import {videoPlacements,hasFreeVideo,getTracks,addTrack,materializeVideoPositions,clipDuration as duration} from './tracks.js';
export const CLIPBOARD_PREFIX = 'cutccc-timeline:v1\n';
export const CLIPBOARD_MIME = 'application/x-cutccc-timeline';
const total = projectDuration;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const clone = value => structuredClone(value);
const fail = message => {throw new Error(message);};
export function encodeClipboard(value) {
  const encoded = CLIPBOARD_PREFIX + JSON.stringify(value);
  if (encoded.length > 8_000_000) fail('复制内容过大。');
  return encoded;
}
export function decodeClipboard(text) {
  if (!text?.startsWith(CLIPBOARD_PREFIX)) return null;
  if (text.length > 8_000_000) fail('复制内容过大。');
  try {return JSON.parse(text.slice(CLIPBOARD_PREFIX.length));}
  catch {fail('无法读取剪辑复制内容。');}
}
export function copyTimelineItems(project, kind, index, placements = []) {
  const result = {version:1,project_id:project.id,kind,items:[]};
  if (kind === 'clip') {
    const clip = project.clips[index];
    if (!clip) fail('请先选中时间轴上的视频片段。');
    const item=clone(clip);delete item.audio_link;result.items = [item];
  } else if (kind === 'voice') {
    const voice = project.voiceovers?.[index];
    if (!voice) fail('请先选中旁白音频。');
    const item=clone(voice);delete item.link_id;result.items = [item];
  } else if (kind === 'captions') {
    if (!placements.length) fail('请先选中时间轴上的字幕。');
    const first = Math.min(...placements.map(c => c.start));
    result.items = placements.map(mapped => {
      const cue = project.subtitles[mapped.sourceId]?.[mapped.index];
      if (!cue) fail('字幕已改变，请重新选择。');
      const [type, rawIndex] = mapped.occurrence.split(':');
      const index = Number(rawIndex);
      let offset;
      if (cue.timeline_offset !== undefined) offset = cue.timeline_offset;
      else if (type === 'voice') offset = project.voiceovers[index].start-audioRange(project.voiceovers[index],project.sources.find(s=>s.id===mapped.sourceId)).start;
      else offset = videoPlacements(project)[index].start - project.clips[index].start;
      offset += cue.shift || 0;
      return {source_id:mapped.sourceId,start:mapped.start-offset,end:mapped.end-offset,
        relative_start:mapped.start-first,text:cue.text,...(cue.style ? {style:clone(cue.style)} : {}),...(cue.track_id?{track_id:cue.track_id}:{})};
    });
  } else fail('此元素不能复制。');
  return result;
}
export function pasteTimelineItems(project, payload, position) {
  if (!payload || payload.version !== 1 || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > 10000)
    fail('无效的剪辑复制内容。');
  if (payload.project_id !== project.id) fail('请在复制内容所属的工程中粘贴。');
  if (!finite(position) || position < 0 || position > total(project) + .001) fail('播放位置不在成片范围内。');
  const p = clone(project);
  const destination=(item,type)=>{
    if(item.track_id===undefined&&p.tracks===undefined)return undefined;
    let track=getTracks(p).find(t=>t.id===item.track_id&&t.type===type)||getTracks(p).find(t=>t.type===type);
    if(!track){const added=addTrack(p,type);p.tracks=added.project.tracks;track=added.track;}
    return track.id;
  };
  let at = Math.min(total(p),Math.round(position*30)/30);
  const sourceFor = item => p.sources.find(s => s.id === item?.source_id) || fail('复制内容引用的素材已被移除。');
  if (payload.kind === 'captions') {
    const newCues=[];
    for (const item of payload.items) {
      const source = sourceFor(item);
      if (!finite(item.start)||!finite(item.end)||item.start < -1e-6||item.end <= item.start||item.end > source.duration+.001||
          !finite(item.relative_start)||item.relative_start<0||typeof item.text!=='string'||!item.text.trim()||[...item.text].length>1000)
        fail('复制的字幕内容或时间无效。');
      validateStyle(item.style);
      if (at+item.relative_start+item.end-item.start > total(p)+1e-6) fail('播放位置之后的空间不足以容纳这些字幕，请把播放头移前一些。');
      const offset = at+item.relative_start-item.start;
      if (Math.abs(offset)>86400) fail('粘贴位置超出字幕时间范围。');
      const track=destination(item,'subtitle');
      const cue={start:Math.max(0,item.start),end:item.end,text:item.text,timeline_offset:offset,...(track?{track_id:track}:{}),
        ...(item.style ? {style:clone(item.style)} : {})};
      const list = p.subtitles[source.id] ||= [];
      if (list.length>=10000) fail('素材的字幕数量已达到上限。');
      list.push(cue);newCues.push({sourceId:source.id,cue});
    }
    for (const list of Object.values(p.subtitles)) list.sort((a,b)=>a.start-b.start||Number(a.timeline_offset!==undefined)-Number(b.timeline_offset!==undefined));
    return {project:p,kind:'captions',position:at,keys:newCues.map(({sourceId,cue})=>`${sourceId}:${p.subtitles[sourceId].indexOf(cue)}`)};
  }
  if (payload.kind === 'voice') {
    if (payload.items.length !== 1) fail('一次粘贴一个旁白音频。');
    const item=payload.items[0],source=sourceFor(item),volume=item.volume??1;
    if (!source.has_audio || !finite(volume)||volume<0||volume>2) fail('旁白音频无效。');
    const range=audioRange(item,source),length=audioDuration(item,source);
    if(!finite(range.start)||!finite(range.end)||range.start<0||range.end>source.duration+.001||length<1/30-1e-9)fail('复制的音频范围无效。');
    if ((!item.detached&&at+length>total(p)+.001)||at+length>86400) fail('播放位置之后的空间不足以容纳音频。');
    p.voiceovers ||= [];
    if (p.voiceovers.length>=32) fail('旁白音频数量已达到上限。');
    const track=destination(item,'audio');
    p.voiceovers.push({source_id:source.id,start:at,volume,...(item.source_start!==undefined?{source_start:item.source_start}:{}),...(item.source_end!==undefined?{source_end:item.source_end}:{}),...(item.detached!==undefined?{detached:item.detached}:{}),...(track?{track_id:track}:{})});
    return {project:p,kind:'voice',position:at,index:p.voiceovers.length-1};
  }
  if (payload.kind !== 'clip' || payload.items.length !== 1) fail('无效的视频片段复制内容。');
  const item=payload.items[0],source=sourceFor(item);
  if (!finite(item.start)||!finite(item.end)||item.start<0||item.end>source.duration+.001||item.end-item.start<1/30)
    fail('复制的视频片段范围无效。');
  const copied={source_id:source.id,start:item.start,end:item.end,...(item.muted?{muted:true}:{})}, added=duration(copied);
  const track=destination(item,'video');
  if(hasFreeVideo(p)||(track&&track!=='video-main')){
    if(p.clips.length>=64)fail('视频片段数量已达到上限。');
    materializeVideoPositions(p);p.clips.push({...copied,timeline_start:at,...(track?{track_id:track}:{})});
    return {project:p,kind:'clip',position:at,index:p.clips.length-1};
  }
  if(at>videoDuration(p)+.001)fail('请在视频轨范围内粘贴视频片段。');
  let offset=0,insertion=p.clips.length;
  for(let i=0;i<p.clips.length;i++) {
    const c=p.clips[i],length=duration(c);
    if(at<=offset+.000001){insertion=i;break;}
    if(at<offset+length-.000001) {
      const cut=c.start+(at-offset);
      if(c.end-cut<1/30-1e-8){at=offset+length;insertion=i+1;break;}
      if(cut-c.start<1/30-1e-8){at=offset;insertion=i;break;}
      p.clips.splice(i,1,{...c,end:cut},{...c,start:cut});insertion=i+1;break;
    }
    offset+=length;
  }
  p.clips.splice(insertion,0,copied);
  if(p.clips.length>64)fail('粘贴后超过64个视频片段的上限。');
  for(const voice of p.voiceovers||[])if(voice.start>=at-.000001)voice.start+=added;
  for(const list of Object.values(p.subtitles))for(const c of list)
    if(c.timeline_offset!==undefined&&c.start+c.timeline_offset+(c.shift||0)>=at-.000001){
      c.timeline_offset+=added;
      if(Math.abs(c.timeline_offset)>86400)fail('插入后字幕超出允许的时间范围。');
    }
  return {project:p,kind:'clip',position:at,index:insertion};
}
