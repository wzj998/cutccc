"""Contiguous audio chunks, with cuts near low-energy regions."""


def split_audio(audio, sr, target_seconds=25):
    """Keep all samples; choose a quiet boundary within 3s of the target.

    This is chunking, not VAD. Word timestamps still come from the aligner.
    """
    import numpy as np

    if sr < 20:
        raise ValueError("Unsupported sample rate")
    if not 5 <= target_seconds <= 25:
        raise ValueError("Target chunk duration must be between 5 and 25 seconds")
    start = 0
    while len(audio) - start > (target_seconds + 5) * sr:
        lo, hi = start + (target_seconds - 3) * sr, start + (target_seconds + 3) * sr
        window = int(0.1 * sr)
        candidates = range(lo, hi, int(0.05 * sr))
        end = min(candidates, key=lambda i: float(np.mean(audio[i:i + window] ** 2))) + window // 2
        yield start / sr, audio[start:end]
        start = end
    if start < len(audio):
        yield start / sr, audio[start:]
