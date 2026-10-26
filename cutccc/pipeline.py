"""Local Qwen3 recognition followed by forced alignment on the recognized text."""

import gc
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from .audio import split_audio
from .models import MODEL_NAMES, validate_models
from .recognition import (LANGUAGES, alignment_language, choose_hypothesis, combine_pass_cues, merge_ranges,
                          review_text, speech_overlap, timed_cues, uncovered_speech)
from .subtitles import add_punctuation, clean, to_srt, validate_cues


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def reserve_output(source, output):
    """Exclusively create a new directory; retain partial results on failure."""
    out = (output or source.parent / (source.stem + "-subtitles")).expanduser().resolve()
    try:
        out.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise ValueError(f"Output already exists: {out}. Select a new --output directory.") from exc
    return out


def transcribe_file(source, output, models_dir, language="auto"):
    if language not in LANGUAGES:
        raise ValueError("Language must be auto, Chinese or English")
    source = Path(source).expanduser().resolve()
    models_dir = Path(models_dir).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Input file does not exist: {source}")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is not on PATH. Install FFmpeg before transcribing.")
    validate_models(models_dir)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner
        from silero_vad import load_silero_vad, get_speech_timestamps
    except ImportError as exc:
        raise RuntimeError("Install CUDA-enabled PyTorch and cutccc[inference]; see README.") from exc
    torch.set_num_threads(8)
    if not torch.cuda.is_available():
        raise RuntimeError("NVIDIA CUDA unavailable; this release requires a CUDA-enabled PyTorch installation.")
    if not torch.cuda.is_bf16_supported():
        raise RuntimeError("This release requires a GPU with BF16 support (e.g. NVIDIA Ampere or newer).")
    out = reserve_output(source, output)
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()

    def emit(stage, **fields):
        print(json.dumps(dict(stage=stage, **fields), ensure_ascii=False), flush=True)

    wav = out / "audio-16k.wav"
    decoded = subprocess.run([
        ffmpeg, "-nostdin", "-v", "error", "-n", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", str(wav),
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if decoded.returncode != 0:
        raise RuntimeError(f"FFmpeg could not extract audio: {decoded.stderr.strip()}")
    audio, sr = sf.read(wav, dtype="float32")
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Invalid audio")
    enhanced_wav = out / "audio-speech-band.wav"
    enhanced_process = subprocess.run([
        ffmpeg, "-nostdin", "-v", "error", "-n", "-i", str(wav), "-af",
        "highpass=f=150,lowpass=f=4200,afftdn=nr=10:nf=-30", "-c:a", "pcm_s16le", str(enhanced_wav),
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if enhanced_process.returncode:
        raise RuntimeError(f"Speech-band preprocessing failed: {enhanced_process.stderr.strip()}")
    enhanced, enhanced_sr = sf.read(enhanced_wav, dtype="float32")
    if enhanced_sr != sr or len(enhanced) != len(audio):
        raise ValueError("Speech-band preprocessing changed the audio timeline")
    emit("detecting_speech")
    detector = load_silero_vad()
    speech_passes = {}
    for variant, samples in (("original", audio), ("speech_band", enhanced)):
        spans = get_speech_timestamps(torch.from_numpy(samples), detector, sampling_rate=sr,
                    threshold=.3, min_speech_duration_ms=160, min_silence_duration_ms=250,
                    speech_pad_ms=250, max_speech_duration_s=12, return_seconds=False)
        speech_passes[variant] = [dict(start=s["start"] / sr, end=s["end"] / sr) for s in spans]
    speech = merge_ranges([s for spans in speech_passes.values() for s in spans], gap=.15)
    save_json(out / "speech-detection.json", dict(passes=speech_passes, speech=speech))
    del detector
    chunks = [(offset, chunk, "scan") for offset, chunk in split_audio(audio, sr, target_seconds=12)]
    for span in speech:
        start, end = round(span["start"] * sr), round(span["end"] * sr)
        chunks.extend((start / sr + offset, chunk, "speech") for offset, chunk in split_audio(audio[start:end], sr, target_seconds=8))
    emit("loading_asr", chunks=len(chunks), duration=len(audio) / sr)
    t = time.perf_counter()
    model = Qwen3ASRModel.from_pretrained(
        str(models_dir / MODEL_NAMES[0]), device_map="cuda:0", dtype=torch.bfloat16,
        attn_implementation="sdpa", max_inference_batch_size=1, max_new_tokens=384,
    )
    asr_load = time.perf_counter() - t
    t = time.perf_counter()
    segments = []
    for index, (offset, chunk, scope) in enumerate(chunks):
        candidates = []
        detected_speech = speech_overlap(offset, offset + len(chunk) / sr, speech)
        if float(np.max(np.abs(chunk))) < 0.0001:
            candidates.append(dict(text="", language="", variant="original"))
        else:
            with torch.inference_mode():
                result = model.transcribe(audio=(chunk, sr), language=None if language == "auto" else language,
                                          context="", return_time_stamps=False)[0]
            candidates.append(dict(text=result.text, language=result.language, variant="original"))
        if scope == "speech" or (clean(candidates[0]["text"]) and detected_speech < .1):
            begin = round(offset * sr)
            with torch.inference_mode():
                result = model.transcribe(audio=(enhanced[begin:begin + len(chunk)], sr),
                                          language=None if language == "auto" else language,
                                          context="", return_time_stamps=False)[0]
            candidates.append(dict(text=result.text, language=result.language, variant="speech_band"))
        selected, reasons = choose_hypothesis(candidates, language)
        text = selected["text"] if selected else ""
        if detected_speech > .1 and not clean(text):
            reasons.append("检测到疑似人声，但两种音频均未得到可用原文")
        segments.append(dict(offset=offset, duration=len(chunk) / sr, text=text,
                             scope=scope,
                             language=selected["language"] if selected else "",
                             variant=selected["variant"] if selected else "original",
                             candidates=candidates, review_reasons=reasons))
        save_json(out / "asr-raw.json", segments)
        emit("transcribed", index=index, text=text)
    asr_seconds = time.perf_counter() - t
    save_json(out / "asr-raw.json", segments)
    del model
    gc.collect()
    torch.cuda.empty_cache()
    emit("loading_aligner")
    t = time.perf_counter()
    aligner = Qwen3ForcedAligner.from_pretrained(
        str(models_dir / MODEL_NAMES[1]), device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa",
    )
    align_load = time.perf_counter() - t
    t = time.perf_counter()
    words, cues = [], []
    for index, ((offset, chunk, scope), segment) in enumerate(zip(chunks, segments)):
        segment["cues"] = []
        if not clean(segment["text"]):
            emit("aligned", index=index, words=0)
            continue
        begin = round(offset * sr)
        samples = enhanced[begin:begin + len(chunk)] if segment["variant"] == "speech_band" else chunk
        try:
            with torch.inference_mode():
                aligned = aligner.align(audio=(samples, sr), text=segment["text"],
                              language=alignment_language(segment["text"], segment["language"]))[0]
            local = [dict(text=w.text, start=round(float(w.start_time) + offset, 3),
                          end=round(float(w.end_time) + offset, 3)) for w in aligned.items]
            decorated = add_punctuation(segment["text"], local)
            segment["word_count"] = len(local)
            words.extend(dict(w, pass_scope=scope, segment_index=index) for w in decorated)
            local_cues, issues = timed_cues(decorated, max_chars=54 if alignment_language(segment["text"]) == "English" else 22)
            segment["review_reasons"].extend(issues)
            for cue in local_cues:
                if cue["start"] < offset or cue["end"] > offset + len(chunk) / sr + .01:
                    segment["review_reasons"].append("时间戳超出音频片段或发生重叠，冲突字幕已排除")
                    continue
                segment["cues"].append(cue)
            emit("aligned", index=index, words=len(local))
        except Exception as exc:
            if "out of memory" in str(exc).lower():
                raise
            segment["review_reasons"].append("识别文字未能可靠对齐，文字候选保留供复核：" + type(exc).__name__)
            emit("aligned", index=index, words=0)
    align_seconds = time.perf_counter() - t
    cues = combine_pass_cues(segments)
    save_json(out / "alignment-raw.json", words)
    duration = len(audio) / sr
    if cues:
        validate_cues(cues, duration)
    (out / "subtitles.srt").write_text(to_srt(cues), encoding="utf-8")
    review = []
    for segment in segments:
        reasons = list(dict.fromkeys(segment["review_reasons"]))
        if reasons:
            start, end = segment["offset"], segment["offset"] + segment["duration"]
            spans = [dict(start=max(start,s["start"]),end=min(end,s["end"])) for s in speech
                     if s["start"] < end and s["end"] > start]
            if not spans:
                spans = [dict(start=start,end=end)]
            for span in spans:
                review.append(dict(start=round(span["start"],3),end=round(span["end"],3),
                                   status="uncertain" if clean(segment["text"]) else "unrecognized",
                                   reasons=reasons,candidates=segment["candidates"]))
    for span in uncovered_speech(speech, cues):
        review.append(dict(**span,status="unrecognized",reasons=["疑似人声没有得到可靠字幕，或仅有部分文字被定位"],candidates=[]))
    review.sort(key=lambda r: (r["start"],r["end"]))
    save_json(out / "review.json", dict(clock="source",language=language,entries=review,
              speech_detection="Silero VAD on original and speech-band audio; suspected speech, not a completeness guarantee"))
    (out / "review.txt").write_text(review_text(review),encoding="utf-8")
    transcript = "\n".join(c["text"] for c in cues)
    (out / "transcript.txt").write_text(transcript, encoding="utf-8")
    meta = dict(
        input_name=source.name, asr=f"Qwen/{MODEL_NAMES[0]}", aligner=f"Qwen/{MODEL_NAMES[1]}",
        offline=True, reference_given_to_asr=False, language=language, translation=False,
        device=torch.cuda.get_device_name(0),
        dtype="bfloat16", attention="sdpa", batch_size=1, duration_seconds=duration,
        asr_load_seconds=asr_load, asr_seconds=asr_seconds, aligner_load_seconds=align_load,
        alignment_seconds=align_seconds, load_and_process_seconds=time.perf_counter() - started,
        peak_allocated_GiB=torch.cuda.max_memory_allocated() / 1024**3,
        peak_reserved_GiB=torch.cuda.max_memory_reserved() / 1024**3,
        transcript=transcript, segments=segments, words=words, cues=cues, review=review, review_count=len(review),
        validation=dict(nonempty=bool(cues), monotonic_nonoverlapping=True, within_audio=True),
    )
    save_json(out / "result.json", meta)
    emit("complete", srt=str(out / "subtitles.srt"), seconds=meta["load_and_process_seconds"],
         peak_GiB=meta["peak_allocated_GiB"])
    return meta
