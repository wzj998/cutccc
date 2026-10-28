import {audioRange,audioDuration,projectDuration} from './audio-tracks.js';
import {videoPlacements,videoDuration,clipDuration as duration} from './tracks.js';

// Clip trims use the source clock. Fixed-time overlays must still fit after a trim.
export function clipResizeContext(project, index, edge) {
  if (!project || !["start", "end"].includes(edge)) return null;
  const clip = project.clips[index];
  const source = project.sources.find(s => s.id === clip?.source_id);
  if (!clip || !source) return null;
  const total = videoDuration(project);
  let overlayEnd = 0;
  for (const voice of project.voiceovers || []) {
    const audio = project.sources.find(s => s.id === voice.source_id);
    if (audio&&!voice.detached&&project.tracks===undefined) overlayEnd = Math.max(overlayEnd, voice.start + audioDuration(voice,audio));
  }
  for (const cues of Object.values(project.subtitles || {})) for (const cue of cues) {
    if (cue.timeline_offset !== undefined)
      overlayEnd = Math.max(overlayEnd, cue.end + cue.timeline_offset + (cue.shift || 0));
  }
  const required = Math.max(1 / 30, Math.ceil((overlayEnd - total + duration(clip)) * 30 - 1e-7) / 30);
  const minimumLength = Math.min(clip.end - clip.start, required);
  const base = clip[edge];
  const lower = edge === "start" ? Math.max(0,clip.start-(clip.timeline_start??Infinity)) : clip.start + minimumLength;
  const upper = edge === "start" ? clip.end - minimumLength : source.duration;
  return {projectId: project.id, index, edge, clip: {...clip}, base,
    minimum: lower - base, maximum: upper - base, total};
}

export function resizedClipRange(context, delta) {
  const bounded = Math.max(context.minimum, Math.min(context.maximum, delta));
  if (bounded === 0) return {...context.clip};
  const value = context.base + bounded;
  const boundary = Math.max(context.base + context.minimum, Math.min(context.base + context.maximum,
    Math.round(value * 1e6) / 1e6));
  return {...context.clip, [context.edge]: boundary,
    ...(context.clip.timeline_start!==undefined&&context.edge==='start'?{timeline_start:Math.max(0,Math.round((context.clip.timeline_start+boundary-context.clip.start)*30)/30)}:{})};
}

// Source-clock bounds for one visible occurrence, including shifts and trimmed clips.
export function captionResizeContext(project, mapped, edge) {
  if (!mapped || !["start", "end"].includes(edge)) return null;
  const cues = project.subtitles[mapped.sourceId], cue = cues?.[mapped.index];
  if (!cue) return null;
  const total = projectDuration(project);
  const [kind, rawIndex] = mapped.occurrence.split(":"), index = Number(rawIndex);
  let offset, lower, upper;
  if (cue.timeline_offset !== undefined) {
    const source = project.sources.find(s => s.id === mapped.sourceId);
    if (!source) return null;
    offset = cue.timeline_offset; lower = 0; upper = source.duration;
  } else if (kind === "clip") {
    const clip = project.clips[index];
    if (!clip || clip.source_id !== mapped.sourceId) return null;
    offset = videoPlacements(project)[index].start - clip.start;
    lower = clip.start; upper = Math.min(clip.end, clip.start + duration(clip));
  } else if (kind === "voice") {
    const voice = project.voiceovers?.[index];
    const source = project.sources.find(s => s.id === mapped.sourceId);
    if (!voice || !source || voice.source_id !== mapped.sourceId) return null;
    const range=audioRange(voice,source);
    offset = voice.start-range.start; lower = range.start; upper = Math.min(range.end, total - voice.start+range.start);
  } else return null;
  offset += cue.shift || 0;
  const original = cues.filter(c => c.timeline_offset === undefined), originalIndex = original.indexOf(cue);
  lower = Math.max(lower, originalIndex >= 0 ? original[originalIndex - 1]?.end ?? 0 : 0, -offset);
  upper = Math.min(upper, originalIndex >= 0 ? original[originalIndex + 1]?.start ?? Infinity : Infinity, total - offset);
  const start = mapped.start - offset, end = mapped.end - offset;
  const base = edge === "start" ? start : end;
  const minimum = (edge === "start" ? lower : start + 1 / 30) - base;
  const maximum = (edge === "start" ? end - 1 / 30 : upper) - base;
  if (minimum > maximum) return null;
  return { projectId: project.id, sourceId: mapped.sourceId, index: mapped.index,
    edge, base, minimum, maximum, mapped, offset };
}

export function resizedCaptionTime(context, delta) {
  const bounded = Math.max(context.minimum, Math.min(context.maximum, delta));
  // Clamp again after decimal rounding so a sub-millisecond adjacent boundary is not crossed.
  return Math.max(context.base + context.minimum, Math.min(context.base + context.maximum,
    Math.round((context.base + bounded) * 1e6) / 1e6));
}
