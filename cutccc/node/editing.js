import { validateStyle } from "../web/subtitle-style.js";
import {audioRange,audioDuration,projectDuration,ownsAudioCaptions} from "../web/audio-tracks.js";
import {videoDuration,videoPlacements,getTracks,DEFAULT_TRACKS} from '../web/tracks.js';
export const FPS = 30;
export class APIError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const fail = (message, status = 400) => {
  throw new APIError(message, status);
};
export const finite = (n) => typeof n === "number" && Number.isFinite(n);
export function roundEven(n) {
  const floor = Math.floor(n);
  return n - floor === 0.5 ? floor + (floor % 2) : Math.round(n);
}
export const clipFrames = (c) =>
  Math.max(1, roundEven((c.end - c.start) * FPS));
export const outputDuration = (clips) =>
  videoDuration({clips});
export function identifier(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
    fail("Invalid identifier");
  return id;
}
export function titleText(title) {
  if (
    typeof title !== "string" ||
    !title.trim() ||
    [...title.trim()].length > 120
  )
    fail("Project title must contain 1–120 characters");
  return title.trim();
}
export function validateEdit(sources, clips, subtitles, tracks) {
  const durations = new Map(sources.map((s) => [s.id, s.duration]));
  if (!Array.isArray(clips) || clips.length > 64)
    fail("A project supports at most 64 clips");
  for (const c of clips) {
    if (!c || !durations.has(c.source_id)) fail("Unknown clip source");
    if (!finite(c.start) || !finite(c.end))
      fail("Clip times must be finite numbers");
    if(c.muted!==undefined&&typeof c.muted!=="boolean")fail("Clip muted must be boolean");
    if(c.audio_link!==undefined&&(typeof c.audio_link!=="string"||!c.audio_link||c.audio_link.length>80))fail("Invalid audio link");
    if(c.timeline_start!==undefined&&(!finite(c.timeline_start)||c.timeline_start<0||c.timeline_start+clipFrames(c)/FPS>86400))fail('Invalid clip timeline position');
    if (
      !(
        0 <= c.start &&
        c.start < c.end &&
        c.end <= durations.get(c.source_id) + 0.001 &&
        c.end - c.start >= 1 / FPS - 1e-8
      )
    )
      fail("Clip range must be within the source and at least one frame long");
  }
  if (!subtitles || Array.isArray(subtitles) || typeof subtitles !== "object")
    fail("Subtitles must be an object");
  for (const [id, cues] of Object.entries(subtitles)) {
    if (!durations.has(id)) fail("Unknown subtitle source");
    if (!Array.isArray(cues) || cues.length > 10000)
      fail("Too many subtitle cues");
    let previous = 0;
    for (const c of cues) {
      if (!c || !finite(c.start) || !finite(c.end))
        fail("Subtitle times must be finite numbers");
      if (
        !(
          (c.timeline_offset !== undefined ? 0 : previous) <= c.start &&
          c.start < c.end &&
          c.end <= durations.get(id) + 0.05
        )
      )
        fail("Subtitles must be ordered, nonoverlapping and within the source");
      if (
        typeof c.text !== "string" ||
        !c.text.trim() ||
        [...c.text].length > 1000
      )
        fail("Subtitle text must contain 1–1000 characters");
      if (c.timeline_offset === undefined) previous = c.end;
      if (c.timeline_offset !== undefined && (!finite(c.timeline_offset) || Math.abs(c.timeline_offset) > 86400))
        fail("Subtitle timeline offset must be within -86400 and 86400 seconds");
      if (c.shift !== undefined && (!finite(c.shift) || Math.abs(c.shift) > 86400))
        fail("Subtitle timeline shift must be within -86400 and 86400 seconds");
      try { validateStyle(c.style); } catch (error) { fail(error.message); }
    }
  }
  validateTracks({sources,clips,subtitles,tracks});
}
export function validateTracks(project) {
  if(project.tracks!==undefined) {
    if(!Array.isArray(project.tracks)||project.tracks.length>64)fail('A project supports at most 64 tracks');
    const ids=new Set();
    for(const t of project.tracks){if(!t||typeof t.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(t.id)||ids.has(t.id)||!['video','audio','subtitle'].includes(t.type)||typeof t.name!=='string'||!t.name.trim()||[...t.name].length>80||Object.entries(DEFAULT_TRACKS).some(([type,id])=>id===t.id&&type!==t.type))fail('Invalid track definition');ids.add(t.id);}
  }
  const definitions=getTracks(project);
  for(const [type,list] of [['video',project.clips],['audio',project.voiceovers||[]],['subtitle',Object.values(project.subtitles||{}).flat()]])
    for(const item of list)if(item.track_id!==undefined&&!definitions.some(t=>t.id===item.track_id&&t.type===type))fail('Material track does not exist or has a different type');
}
export function validateVoiceovers(sources, clips, voices, tracks) {
  if (!Array.isArray(voices) || voices.length > 32)
    fail("A project supports at most 32 voiceovers");
  for (const v of voices) {
    const source = sources.find((s) => s.id === v?.source_id);
    if (!source?.has_audio) fail("Voiceover source must contain audio");
    const volume = v.volume ?? 1;
    if (!finite(v.start) || !finite(volume))
      fail("Voiceover start and volume must be finite numbers");
    const range=audioRange(v,source);
    if(!finite(range.start)||!finite(range.end)||range.start<0||range.end>source.duration+.001||range.end-range.start<1/30-1e-9)
      fail("Audio trim must be within the source and retain at least one frame");
    if(v.detached!==undefined&&typeof v.detached!=="boolean")fail("Audio detached must be boolean");
    if(v.link_id!==undefined&&(typeof v.link_id!=="string"||!v.link_id||v.link_id.length>80))fail("Invalid audio link");
    if (v.start < 0 || v.start+audioDuration(v,source)>86400 || (!v.detached && tracks===undefined && v.start + audioDuration(v,source) > outputDuration(clips) + 0.05))
      fail("Voiceover must fit within the output timeline");
    if (volume < 0 || volume > 2)
      fail("Voiceover volume must be between 0 and 2");
  }
  validateTracks({sources,clips,subtitles:{},voiceovers:voices,tracks});
}
const millis = (n) => roundEven(n * 1000) / 1000;
export function mapSubtitles(clips, subtitles, voiceovers = [], sources = [], tracks) {
  const project={clips,subtitles,voiceovers,sources,tracks};
  let offset = 0;
  const cues = [];
  for (const placement of videoPlacements(project)) {
    const clip=placement.clip;offset=placement.start;
    const duration = clipFrames(clip) / FPS;
    for (const c of subtitles[clip.source_id] || []) {
      if(ownsAudioCaptions(project,clip))continue;
      if (c.timeline_offset !== undefined) continue;
      const start = Math.max(clip.start, c.start),
        end = Math.min(clip.end, c.end, clip.start + duration);
      if (end - start >= 0.001)
        cues.push({
          start: millis(offset + start - clip.start),
          end: millis(offset + end - clip.start),
          text: c.text,
          ...(c.style === undefined ? {} : { style: structuredClone(c.style) }),
          ...(c.shift === undefined ? {} : {shift: c.shift}),
        });
    }
    offset += duration;
  }
  for (const voice of voiceovers) {
    const source = sources.find(s => s.id === voice.source_id);
    if (!source) continue;
    const range=audioRange(voice,source);
    for (const cue of subtitles[voice.source_id] || []) {
      if (cue.timeline_offset !== undefined) continue;
      const start = Math.max(range.start, cue.start), end = Math.min(cue.end, range.end, projectDuration(project) - voice.start + range.start);
      if (end - start >= .001) cues.push({
        start: millis(voice.start + start-range.start), end: millis(voice.start + end-range.start), text: cue.text,
        ...(cue.style === undefined ? {} : {style: structuredClone(cue.style)}),
        ...(cue.shift === undefined ? {} : {shift: cue.shift}),
      });
    }
  }
  for (const list of Object.values(subtitles)) for (const cue of list) {
    if (cue.timeline_offset === undefined) continue;
    cues.push({start: millis(cue.start + cue.timeline_offset), end: millis(cue.end + cue.timeline_offset), text: cue.text,
      ...(cue.style === undefined ? {} : {style: structuredClone(cue.style)}), shift: cue.shift || 0});
  }
  return cues.map(({shift = 0, ...cue}) => ({...cue,
    start: millis(Math.max(0, cue.start + shift)), end: millis(Math.min(projectDuration(project), cue.end + shift)),
  })).filter(cue => cue.end > cue.start).sort((a, b) => a.start - b.start);
}
export function timestamp(seconds) {
  if (!finite(seconds) || seconds < 0)
    fail("Timestamp must be finite and nonnegative");
  let ms = roundEven(seconds * 1000);
  const hours = Math.floor(ms / 3600000);
  ms %= 3600000;
  const minutes = Math.floor(ms / 60000);
  ms %= 60000;
  const sec = Math.floor(ms / 1000);
  ms %= 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
export function toSrt(cues) {
  return cues.length
    ? cues
        .map(
          (c, i) =>
            `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.text}`,
        )
        .join("\n\n") + "\n"
    : "";
}
