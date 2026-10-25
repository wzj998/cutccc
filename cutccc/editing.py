"""Shared edit validation and source-to-output subtitle mapping."""

import math

FPS = 30


def clip_frames(clip):
    return max(1, round((clip["end"] - clip["start"]) * FPS))


def output_duration(clips):
    return sum(clip_frames(c) for c in clips) / FPS


def validate_edit(sources, clips, subtitles):
    durations = {s["id"]: s["duration"] for s in sources}
    if len(clips) > 64:
        raise ValueError("A project supports at most 64 clips")
    for clip in clips:
        if clip.get("source_id") not in durations:
            raise ValueError("Unknown clip source")
        start, end = clip.get("start"), clip.get("end")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, end)):
            raise ValueError("Clip times must be finite numbers")
        if not (0 <= start < end <= durations[clip["source_id"]] + 0.001) or end - start < 1 / FPS:
            raise ValueError("Clip range must be within the source and at least one frame long")
    for source_id, cues in subtitles.items():
        if source_id not in durations:
            raise ValueError("Unknown subtitle source")
        if len(cues) > 10000:
            raise ValueError("Too many subtitle cues")
        previous = 0
        for cue in cues:
            start, end = cue.get("start"), cue.get("end")
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, end)):
                raise ValueError("Subtitle times must be finite numbers")
            if not (previous <= start < end <= durations[source_id] + 0.05):
                raise ValueError("Subtitles must be ordered, nonoverlapping and within the source")
            if not isinstance(cue.get("text"), str) or not cue["text"].strip() or len(cue["text"]) > 1000:
                raise ValueError("Subtitle text must contain 1–1000 characters")
            previous = end


def map_subtitles(clips, subtitles):
    """Intersect source cues with each clip and move them to the output clock.

    A cut through a cue retains its text; users can edit the partial sentence.
    """
    result, offset = [], 0.0
    for clip in clips:
        duration = clip_frames(clip) / FPS
        for cue in subtitles.get(clip["source_id"], []):
            start = max(clip["start"], cue["start"])
            end = min(clip["end"], cue["end"], clip["start"] + duration)
            if end - start >= 0.001:
                result.append(dict(start=round(offset + start - clip["start"], 3),
                                   end=round(offset + end - clip["start"], 3), text=cue["text"]))
        offset += duration
    return result
