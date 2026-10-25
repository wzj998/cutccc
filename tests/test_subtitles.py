import math
import unittest

from cutccc.subtitles import add_punctuation, make_cues, timestamp, to_srt, validate_cues


class SubtitleTests(unittest.TestCase):
    def test_punctuation_preserves_words_and_model_timing(self):
        words = [dict(text=c, start=i * 0.2, end=i * 0.2 + 0.15) for i, c in enumerate("你好世界")]
        decorated = add_punctuation("你好，世界！", words)
        self.assertEqual("".join(w["display"] for w in decorated), "你好，世界！")
        cues = make_cues(decorated)
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[1]["start"], words[2]["start"])
        self.assertEqual(cues[-1]["end"], words[-1]["end"])

    def test_alignment_omission_is_not_silently_repaired(self):
        with self.assertRaisesRegex(ValueError, "omitted"):
            add_punctuation("银行", [dict(text="银", start=0, end=1)])

    def test_alignment_mismatch_is_not_silently_repaired(self):
        with self.assertRaisesRegex(ValueError, "differ"):
            add_punctuation("银行", [dict(text="音", start=0, end=1)])

    def test_mixed_numbers_and_latin_punctuation(self):
        words = [dict(text=t, start=i, end=i + 0.5) for i, t in enumerate(["测", "试", "12GB", "ok"])]
        result = add_punctuation("测试 12GB，OK！", words)
        self.assertEqual("".join(w["display"] for w in result), "测试 12GB，OK！")

    def test_long_line_split_keeps_content_and_boundaries(self):
        words = [dict(text="字", display="字", start=i * 0.2, end=i * 0.2 + 0.15) for i in range(50)]
        cues = make_cues(words)
        self.assertEqual("".join(c["text"] for c in cues), "字" * 50)
        self.assertTrue(all(len(c["text"]) <= 22 for c in cues))
        self.assertEqual(cues[-1]["end"], words[-1]["end"])
        validate_cues(cues, 10)

    def test_silence_gap_splits_cues(self):
        words = [dict(text="甲", display="甲", start=0, end=1), dict(text="乙", display="乙", start=3, end=4)]
        self.assertEqual(len(make_cues(words)), 2)

    def test_timestamp_rounding_carries(self):
        self.assertEqual(timestamp(59.9996), "00:01:00,000")
        self.assertEqual(timestamp(3661.125), "01:01:01,125")
        for value in [-1, math.nan, math.inf]:
            with self.assertRaises(ValueError):
                timestamp(value)

    def test_invalid_cues_rejected(self):
        invalid = [
            [], [dict(start=1, end=1, text="字")], [dict(start=0, end=4, text="字")],
            [dict(start=0, end=math.nan, text="字")], [dict(start=0, end=1, text=" ")],
            [dict(start=0, end=0.0001, text="字")],
            [dict(start=0, end=2, text="甲"), dict(start=1, end=3, text="乙")],
        ]
        for cues in invalid:
            with self.subTest(cues=cues), self.assertRaises(ValueError):
                validate_cues(cues, 3)

    def test_srt_format(self):
        self.assertEqual(to_srt([dict(start=1.25, end=2.5, text="你好。")]),
                         "1\n00:00:01,250 --> 00:00:02,500\n你好。\n")


if __name__ == "__main__":
    unittest.main()
