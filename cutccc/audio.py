"""Contiguous audio chunks, with cuts near low-energy regions."""


def split_audio(audio, sr):
    """Keep all samples; choose a quiet boundary between 22 and 28 seconds.

    This is chunking, not VAD. Word timestamps still come from the aligner.
    """
    import numpy as np

    if sr < 20:
        raise ValueError("Unsupported sample rate")
    start = 0
    while len(audio) - start > 30 * sr:
        lo, hi = start + 22 * sr, start + 28 * sr
        window = int(0.1 * sr)
        candidates = range(lo, hi, int(0.05 * sr))
        end = min(candidates, key=lambda i: float(np.mean(audio[i:i + window] ** 2))) + window // 2
        yield start / sr, audio[start:end]
        start = end
    if start < len(audio):
        yield start / sr, audio[start:]
