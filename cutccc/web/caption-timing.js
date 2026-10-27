const duration = clip => Math.round((clip.end - clip.start) * 30) / 30;

// Source-clock bounds for one visible occurrence, including shifts and trimmed clips.
export function captionResizeContext(project, mapped, edge) {
  if (!mapped || !["start", "end"].includes(edge)) return null;
  const cues = project.subtitles[mapped.sourceId], cue = cues?.[mapped.index];
  if (!cue) return null;
  const total = project.clips.reduce((n, c) => n + duration(c), 0);
  const [kind, rawIndex] = mapped.occurrence.split(":"), index = Number(rawIndex);
  let offset, lower, upper;
  if (cue.timeline_offset !== undefined) {
    const source = project.sources.find(s => s.id === mapped.sourceId);
    if (!source) return null;
    offset = cue.timeline_offset; lower = 0; upper = source.duration;
  } else if (kind === "clip") {
    const clip = project.clips[index];
    if (!clip || clip.source_id !== mapped.sourceId) return null;
    offset = project.clips.slice(0, index).reduce((n, c) => n + duration(c), 0) - clip.start;
    lower = clip.start; upper = Math.min(clip.end, clip.start + duration(clip));
  } else if (kind === "voice") {
    const voice = project.voiceovers?.[index];
    const source = project.sources.find(s => s.id === mapped.sourceId);
    if (!voice || !source || voice.source_id !== mapped.sourceId) return null;
    offset = voice.start; lower = 0; upper = Math.min(source.duration, total - voice.start);
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
