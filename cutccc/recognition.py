"""Language-preserving hypothesis selection and explicit recognition review ranges."""

from difflib import SequenceMatcher
import math
import re

from .subtitles import clean, make_cues, timestamp

LANGUAGES = ("auto", "Chinese", "English")


def alignment_language(text, detected=""):
    if re.search(r"[\u3400-\u9fff]", text):
        if "Cantonese" in detected:
            return "Cantonese"
        return "Chinese"
    if re.search(r"[a-zA-Z]", text):
        return "English"
    return detected.split(",")[0].strip() or "English"


def merge_ranges(ranges, gap=0):
    merged = []
    for span in sorted(ranges, key=lambda s: s["start"]):
        start, end = float(span["start"]), float(span["end"])
        if end <= start:
            continue
        if merged and start <= merged[-1]["end"] + gap:
            merged[-1]["end"] = max(merged[-1]["end"], end)
        else:
            merged.append(dict(start=start, end=end))
    return merged


def speech_overlap(start, end, speech):
    return sum(max(0, min(end, s["end"]) - max(start, s["start"])) for s in speech)


def choose_hypothesis(candidates, requested="auto"):
    """Never translate or force a second language onto the first transcript."""
    nonempty = [c for c in candidates if clean(c["text"])]
    if not nonempty:
        return None, []
    eligible = nonempty
    reasons = []
    if requested == "auto":
        eligible = [c for c in nonempty if {v.strip() for v in c.get("language", "").split(",")} <= {"Chinese", "Cantonese", "English"}]
        if not eligible:
            return None, ["语种检测结果不是中文或英文，未将其强行改写为英文"]
        if len(eligible) != len(nonempty):
            reasons.append("原声与降噪后的语种检测不一致")
    chosen = eligible[0]
    if len(candidates) > 1 and len(eligible) == 1:
        reasons.append("仅一种音频版本得到可用文字，需要复听")
    if len(eligible) > 1:
        a, b = eligible[:2]
        similarity = SequenceMatcher(None, clean(a["text"]), clean(b["text"])).ratio()
        if similarity < .65:
            reasons.append("原声与降噪转写差异较大，可能有失真或重叠人声")
        elif clean(a["text"]) != clean(b["text"]):
            reasons.append("原声与降噪候选存在字词差异，需要核对原话")
        if similarity >= .65 and clean(a["text"]) in clean(b["text"]) and len(clean(b["text"])) > len(clean(a["text"])):
            chosen = b
    return chosen, reasons


def timed_cues(words, max_chars=22):
    """Retain measured phrase spans; report zero/invalid timings instead of inventing them."""
    cues, pending, issues = [], [], []
    def join(left, right):
        separator = " " if re.search(r"[A-Za-z0-9,.;:!?]$", left) and re.match(r"[A-Za-z0-9]", right) else ""
        return left + separator + right
    for cue in make_cues(words, max_chars=max_chars):
        start, end = cue["start"], cue["end"]
        if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in (start, end)) or start < 0 or end < start:
            issues.append("部分文字时间戳无效，未写入字幕")
            continue
        if round(end * 1000) <= round(start * 1000):
            issues.append("部分词没有独立的可靠时间戳")
            if cues and abs(start - cues[-1]["end"]) <= .05:
                cues[-1]["text"] = join(cues[-1]["text"], cue["text"])
            else:
                pending.append(cue)
            continue
        for zero in pending:
            if abs(zero["start"] - start) <= .05:
                cue["text"] = join(zero["text"], cue["text"])
            else:
                issues.append("无法定位的文字已保留在复核报告")
        pending.clear()
        if cues and start < cues[-1]["end"]:
            issues.append("时间戳重叠，冲突文字未写入字幕")
            continue
        density = len(clean(cue["text"])) / max(.001, end - start)
        limit = 28 if re.search(r"[\u3400-\u9fff]", cue["text"]) else 80
        if density > limit:
            issues.append("文字被压缩到不合理的短时间，未写入字幕")
            continue
        cues.append(cue)
    if pending:
        issues.append("无法定位的文字已保留在复核报告")
    checked = []
    for cue in cues:
        limit = 28 if re.search(r"[\u3400-\u9fff]", cue["text"]) else 80
        if len(clean(cue["text"])) / (cue["end"] - cue["start"]) > limit:
            issues.append("文字被压缩到不合理的短时间，未写入字幕")
        else:
            checked.append(cue)
    return checked, list(dict.fromkeys(issues))


def uncovered_speech(speech, cues, minimum=.65, padding=.15):
    covered = merge_ranges([dict(start=max(0, c["start"] - padding), end=c["end"] + padding) for c in cues])
    missing = []
    for span in speech:
        cursor = span["start"]
        for cue in covered:
            if cue["end"] <= cursor or cue["start"] >= span["end"]:
                continue
            if cue["start"] - cursor >= minimum:
                missing.append(dict(start=round(cursor, 3), end=round(cue["start"], 3)))
            cursor = max(cursor, cue["end"])
        if span["end"] - cursor >= minimum:
            missing.append(dict(start=round(cursor, 3), end=round(span["end"], 3)))
    return merge_ranges(missing, gap=.25)


def combine_pass_cues(segments):
    """Prefer short speech-focused passes; retain the full-audio scan outside them."""
    focused = []
    for segment in segments:
        if segment.get("scope") != "speech" or not segment.get("cues"):
            continue
        has_chinese = bool(re.search(r"[\u3400-\u9fff]", segment["text"]))
        parents = [s for s in segments if s.get("scope") != "speech" and s.get("text")
                   and s["offset"] < segment["offset"] + segment["duration"]
                   and s["offset"] + s["duration"] > segment["offset"]]
        conflict = parents and all(
            (not re.search(r"[\u3400-\u9fff]", s["text"]) if has_chinese else
             bool(re.search(r"[\u3400-\u9fff]", s["text"])) and len(re.findall(r"[A-Za-z]+", s["text"])) < 3)
            for s in parents)
        parent_text = "".join(c["text"] for s in parents for c in s.get("cues", [])
                             if c["start"] < segment["offset"] + segment["duration"] and c["end"] > segment["offset"])
        a, b = clean(parent_text), clean("".join(c["text"] for c in segment["cues"]))
        if a and b and a not in b and b not in a:
            segment["review_reasons"].append("短句复听与全段扫描的字词有差异，需要复核")
        if conflict:
            segment["review_reasons"].append("短句与全段扫描的中英语种相矛盾，保留全段候选供复核")
        else:
            focused.append(segment)
    protected = merge_ranges([dict(start=s["offset"], end=s["offset"] + s["duration"]) for s in focused])
    candidates = []
    for s in segments:
        if s.get("scope") == "speech" and not any(s is item for item in focused):
            continue
        for cue in s.get("cues", []):
            if s.get("scope") != "speech" and speech_overlap(cue["start"], cue["end"], protected) > .01:
                continue
            candidates.append((cue, s))
    result = []
    for cue, segment in sorted(candidates, key=lambda item: (item[0]["start"], item[0]["end"])):
        if result and cue["start"] < result[-1]["end"]:
            segment["review_reasons"].append("相邻复听片段的时间戳重叠，冲突字幕已排除")
            continue
        result.append(cue)
    return result


def review_text(entries):
    lines = ["识别复核清单（原素材时间）", "英文保留英文原文；本流程不翻译。",
             "以下是自动检测的疑似遗漏或不确定区间，并非完整人工审听结果。", ""]
    if not entries:
        lines.append("未检出需要复核的区间；这不等于保证所有人声均已识别。")
    for i, entry in enumerate(entries, 1):
        lines.append(f"{i}. {timestamp(entry['start'])} – {timestamp(entry['end'])} [{entry['status']}]")
        lines.extend("   " + reason for reason in entry["reasons"])
        for candidate in entry.get("candidates", []):
            lines.append(f"   {candidate.get('variant', '')} / {candidate.get('language', '')}: {candidate['text']}")
        lines.append("")
    return "\n".join(lines) + "\n"
