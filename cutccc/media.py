"""FFmpeg media inspection and deterministic edit rendering."""

import json
import math
import os
import shutil
import subprocess

from .editing import FPS, clip_frames, map_subtitles, output_duration
from .subtitles import to_srt


def binary(name):
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"{name} is required on PATH")
    return path


def probe(path):
    result = subprocess.run([binary("ffprobe"), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    if result.returncode:
        raise ValueError("Cannot read this video; check its format and contents")
    data = json.loads(result.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    if not video:
        raise ValueError("The editor requires a video stream")
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    if not math.isfinite(duration) or duration < 1 / FPS:
        raise ValueError("Video duration is invalid")
    width, height = int(video["width"]), int(video["height"])
    rotation = next((int(s.get("rotation", 0)) for s in video.get("side_data_list", []) if "rotation" in s), 0)
    if abs(rotation) % 180 == 90:
        width, height = height, width
    return dict(duration=duration, width=width, height=height,
                has_audio=any(s.get("codec_type") == "audio" for s in data.get("streams", [])))


def thumbnail(source, target):
    subprocess.run([binary("ffmpeg"), "-nostdin", "-v", "error", "-i", str(source), "-frames:v", "1",
                    "-vf", "scale=480:-2", "-y", str(target)], capture_output=True, timeout=60, check=True)


def render(project, folder, source_path, run_process, burn_subtitles=True):
    clips = project["clips"]
    if not clips:
        raise ValueError("Add at least one clip before exporting")
    sources = {s["id"]: s for s in project["sources"]}
    first = sources[clips[0]["source_id"]]
    scale = min(1.0, 1920 / max(first["width"], first["height"]))
    width = max(2, round(first["width"] * scale / 2) * 2)
    height = max(2, round(first["height"] * scale / 2) * 2)
    command = [binary("ffmpeg"), "-nostdin", "-v", "error", "-y"]
    filters = []
    for i, clip in enumerate(clips):
        command.extend(["-i", str(source_path(clip["source_id"]))])
        start, end = clip["start"], clip["end"]
        frames = clip_frames(clip)
        duration = frames / FPS
        filters.append(f"[{i}:v:0]trim=start={start}:end={end},setpts=PTS-STARTPTS,"
                       f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                       f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={FPS},"
                       f"tpad=stop_mode=clone:stop_duration=1,trim=end_frame={frames},setpts=PTS-STARTPTS[v{i}]")
        if sources[clip["source_id"]]["has_audio"]:
            filters.append(f"[{i}:a:0]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
                           f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                           f"apad,atrim=duration={duration}[a{i}]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={duration}[a{i}]")
    filters.append("".join(f"[v{i}][a{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=1[vcat][acat]")
    cues = map_subtitles(clips, project["subtitles"])
    (folder / "subtitles.srt").write_text(to_srt(cues) if cues else "", encoding="utf-8")
    video_label = "[vcat]"
    if burn_subtitles and cues:
        font = "Microsoft YaHei" if os.name == "nt" else "Noto Sans CJK SC"
        filters.append(f"[vcat]subtitles=subtitles.srt:force_style='FontName={font},FontSize=18,MarginV=24,Outline=2,Shadow=0'[vout]")
        video_label = "[vout]"
    (folder / "filters.txt").write_text(";\n".join(filters), encoding="utf-8")
    command.extend(["-filter_complex_script", "filters.txt", "-map", video_label, "-map", "[acat]",
                    "-frames:v", str(sum(clip_frames(c) for c in clips)), "-t", str(output_duration(clips)),
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:1", "video.mp4"])
    run_process(command, folder, output_duration(clips))
    result = probe(folder / "video.mp4")
    if abs(result["duration"] - output_duration(clips)) > 0.1:
        raise RuntimeError("Export duration does not match the edit")
    return dict(duration=result["duration"], width=result["width"], height=result["height"],
                subtitle_count=len(cues), project_revision=project["revision"])
