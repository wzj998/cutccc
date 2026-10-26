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
  clips.reduce((n, c) => n + clipFrames(c), 0) / FPS;
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
export function validateEdit(sources, clips, subtitles) {
  const durations = new Map(sources.map((s) => [s.id, s.duration]));
  if (!Array.isArray(clips) || clips.length > 64)
    fail("A project supports at most 64 clips");
  for (const c of clips) {
    if (!c || !durations.has(c.source_id)) fail("Unknown clip source");
    if (!finite(c.start) || !finite(c.end))
      fail("Clip times must be finite numbers");
    if (
      !(
        0 <= c.start &&
        c.start < c.end &&
        c.end <= durations.get(c.source_id) + 0.001 &&
        c.end - c.start >= 1 / FPS
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
          previous <= c.start &&
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
      previous = c.end;
    }
  }
}
export function validateVoiceovers(sources, clips, voices) {
  if (!Array.isArray(voices) || voices.length > 32)
    fail("A project supports at most 32 voiceovers");
  for (const v of voices) {
    const source = sources.find((s) => s.id === v?.source_id);
    if (!source?.has_audio) fail("Voiceover source must contain audio");
    const volume = v.volume ?? 1;
    if (!finite(v.start) || !finite(volume))
      fail("Voiceover start and volume must be finite numbers");
    if (v.start < 0 || v.start + source.duration > outputDuration(clips) + 0.05)
      fail("Voiceover must fit within the output timeline");
    if (volume < 0 || volume > 2)
      fail("Voiceover volume must be between 0 and 2");
  }
}
const millis = (n) => roundEven(n * 1000) / 1000;
export function mapSubtitles(clips, subtitles) {
  let offset = 0;
  const cues = [];
  for (const clip of clips) {
    const duration = clipFrames(clip) / FPS;
    for (const c of subtitles[clip.source_id] || []) {
      const start = Math.max(clip.start, c.start),
        end = Math.min(clip.end, c.end, clip.start + duration);
      if (end - start >= 0.001)
        cues.push({
          start: millis(offset + start - clip.start),
          end: millis(offset + end - clip.start),
          text: c.text,
        });
    }
    offset += duration;
  }
  return cues;
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
