import unittest

import numpy as np

from cutccc.audio import split_audio


class AudioTests(unittest.TestCase):
    def test_chunks_keep_every_sample_and_offsets(self):
        sr = 1000
        audio = np.ones(71 * sr, dtype=np.float32)
        audio[24 * sr:25 * sr] = 0
        chunks = list(split_audio(audio, sr))
        np.testing.assert_array_equal(np.concatenate([chunk for _, chunk in chunks]), audio)
        consumed = 0
        for offset, chunk in chunks:
            self.assertEqual(offset, consumed / sr)
            consumed += len(chunk)
            self.assertLessEqual(len(chunk), 30 * sr)
        self.assertTrue(24 <= chunks[1][0] < 25)

    def test_short_and_empty_audio(self):
        self.assertEqual(list(split_audio(np.zeros(0), 16000)), [])
        audio = np.ones(100)
        chunks = list(split_audio(audio, 16000))
        self.assertEqual(len(chunks), 1)
        np.testing.assert_array_equal(chunks[0][1], audio)

    def test_shorter_mixed_language_chunks_keep_the_complete_audio(self):
        sr = 1000
        audio = np.ones(71 * sr, dtype=np.float32)
        chunks = list(split_audio(audio, sr, target_seconds=12))
        np.testing.assert_array_equal(np.concatenate([chunk for _, chunk in chunks]), audio)
        self.assertTrue(all(len(chunk) <= 17 * sr for _, chunk in chunks))
        with self.assertRaises(ValueError):
            list(split_audio(audio, sr, target_seconds=0))


if __name__ == "__main__":
    unittest.main()
