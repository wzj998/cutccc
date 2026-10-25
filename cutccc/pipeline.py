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
from .subtitles import add_punctuation, clean, make_cues, to_srt, validate_cues


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


def transcribe_file(source, output, models_dir):
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
    chunks = list(split_audio(audio, sr))
    emit("loading_asr", chunks=len(chunks), duration=len(audio) / sr)
    t = time.perf_counter()
    model = Qwen3ASRModel.from_pretrained(
        str(models_dir / MODEL_NAMES[0]), device_map="cuda:0", dtype=torch.bfloat16,
        attn_implementation="sdpa", max_inference_batch_size=1, max_new_tokens=1024,
    )
    asr_load = time.perf_counter() - t
    t = time.perf_counter()
    segments = []
    for index, (offset, chunk) in enumerate(chunks):
        if float(np.max(np.abs(chunk))) < 0.0001:
            text = ""
        else:
            with torch.inference_mode():
                result = model.transcribe(audio=(chunk, sr), language="Chinese", context="", return_time_stamps=False)[0]
            text = result.text
        segments.append(dict(offset=offset, duration=len(chunk) / sr, text=text))
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
    words = []
    for index, ((offset, chunk), segment) in enumerate(zip(chunks, segments)):
        if not clean(segment["text"]):
            continue
        with torch.inference_mode():
            aligned = aligner.align(audio=(chunk, sr), text=segment["text"], language="Chinese")[0]
        local = [dict(text=w.text, start=round(float(w.start_time) + offset, 3),
                      end=round(float(w.end_time) + offset, 3)) for w in aligned.items]
        segment["word_count"] = len(local)
        words.extend(add_punctuation(segment["text"], local))
        emit("aligned", index=index, words=len(local))
    align_seconds = time.perf_counter() - t
    save_json(out / "alignment-raw.json", words)
    cues = make_cues(words)
    duration = len(audio) / sr
    validate_cues(cues, duration)
    (out / "subtitles.srt").write_text(to_srt(cues), encoding="utf-8")
    transcript = "".join(s["text"] for s in segments)
    (out / "transcript.txt").write_text(transcript, encoding="utf-8")
    meta = dict(
        input_name=source.name, asr=f"Qwen/{MODEL_NAMES[0]}", aligner=f"Qwen/{MODEL_NAMES[1]}",
        offline=True, reference_given_to_asr=False, device=torch.cuda.get_device_name(0),
        dtype="bfloat16", attention="sdpa", batch_size=1, duration_seconds=duration,
        asr_load_seconds=asr_load, asr_seconds=asr_seconds, aligner_load_seconds=align_load,
        alignment_seconds=align_seconds, load_and_process_seconds=time.perf_counter() - started,
        peak_allocated_GiB=torch.cuda.max_memory_allocated() / 1024**3,
        peak_reserved_GiB=torch.cuda.max_memory_reserved() / 1024**3,
        transcript=transcript, segments=segments, words=words, cues=cues,
        validation=dict(nonempty=True, monotonic_nonoverlapping=True, within_audio=True),
    )
    save_json(out / "result.json", meta)
    emit("complete", srt=str(out / "subtitles.srt"), seconds=meta["load_and_process_seconds"],
         peak_GiB=meta["peak_allocated_GiB"])
    return meta
