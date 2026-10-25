"""Build subtitle cues from actual model timestamps; never divide time by text length."""

import math
import re


def clean(text):
    return "".join(c.lower() for c in text if c.isalnum())


def timestamp(seconds):
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("Timestamp must be finite and nonnegative")
    ms = round(seconds * 1000)
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    seconds, ms = divmod(ms, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{ms:03}"


def add_punctuation(text, words):
    """Reattach ASR punctuation without changing aligned token boundaries."""
    positions = [i for i, c in enumerate(text) if c.isalnum()]
    normalized = clean(text)
    cursor = 0
    result = []
    for word in words:
        token = clean(word["text"])
        if not token:
            continue
        if normalized[cursor:cursor + len(token)] != token:
            raise ValueError("Aligner tokens differ from ASR transcript")
        begin = 0 if cursor == 0 else positions[cursor]
        cursor += len(token)
        end = positions[cursor] if cursor < len(positions) else len(text)
        result.append(dict(word, display=text[begin:end]))
    if cursor != len(positions):
        raise ValueError("Aligner omitted transcript tokens")
    return result


def make_cues(words, max_chars=22, max_seconds=6):
    cues, group = [], []

    def finish():
        if group:
            cues.append(dict(start=group[0]["start"], end=group[-1]["end"],
                             text="".join(w["display"] for w in group).strip()))
            group.clear()

    for word in words:
        if group and (len("".join(w["display"] for w in group)) + len(word["display"]) > max_chars
                      or word["end"] - group[0]["start"] > max_seconds
                      or word["start"] - group[-1]["end"] > 0.5):
            finish()
        group.append(word)
        if re.search(r"[，。！？；：,.!?;:]\s*$", word["display"]):
            finish()
    finish()
    return cues


def validate_cues(cues, duration):
    if not cues:
        raise ValueError("No speech recognized")
    for i, cue in enumerate(cues):
        start, end = cue["start"], cue["end"]
        if not (math.isfinite(start) and math.isfinite(end)
                and 0 <= start < end <= duration + 0.05):
            raise ValueError(f"Invalid subtitle boundary at cue {i + 1}")
        if not cue["text"].strip():
            raise ValueError(f"Empty subtitle at cue {i + 1}")
        if i and start < cues[i - 1]["end"] - 0.001:
            raise ValueError(f"Overlapping subtitle at cue {i + 1}")
        if round(start * 1000) >= round(end * 1000):
            raise ValueError(f"Subtitle too short for SRT precision at cue {i + 1}")


def to_srt(cues):
    return "\n\n".join(
        f"{i}\n{timestamp(c['start'])} --> {timestamp(c['end'])}\n{c['text']}"
        for i, c in enumerate(cues, 1)
    ) + "\n"
