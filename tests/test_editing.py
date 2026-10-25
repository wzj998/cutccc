import unittest

from cutccc.editing import validate_edit, map_subtitles, output_duration


class EditingTests(unittest.TestCase):
    def setUp(self):
        self.sources = [{"id": "a", "duration": 10}, {"id": "b", "duration": 4}]

    def test_reorder_repeat_and_clip_subtitles_to_output(self):
        clips = [{"source_id": "b", "start": 1, "end": 3},
                 {"source_id": "a", "start": 4, "end": 7},
                 {"source_id": "b", "start": 1, "end": 3}]
        cues = {"a": [{"start": 3, "end": 5, "text": "甲"}],
                "b": [{"start": 0, "end": 2, "text": "乙"}]}
        validate_edit(self.sources, clips, cues)
        mapped = map_subtitles(clips, cues)
        self.assertEqual(mapped, [{"start": 0, "end": 1, "text": "乙"},
                                  {"start": 2, "end": 3, "text": "甲"},
                                  {"start": 5, "end": 6, "text": "乙"}])
        self.assertEqual(output_duration(clips), 7)

    def test_invalid_ranges_and_nonfinite_values(self):
        for start, end in [(-1, 2), (2, 2), (3, 2), (0, 11), (float("nan"), 2), (0, float("inf"))]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                validate_edit(self.sources, [{"source_id": "a", "start": start, "end": end}], {})
        with self.assertRaises(ValueError):
            validate_edit(self.sources, [{"source_id": "unknown", "start": 0, "end": 1}], {})

    def test_overlap_in_source_subtitles_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_edit(self.sources, [], {"a": [{"start": 0, "end": 2, "text": "甲"},
                                                    {"start": 1, "end": 3, "text": "乙"}]})

    def test_empty_edit_is_allowed_but_duration_is_zero(self):
        validate_edit(self.sources, [], {})
        self.assertEqual(output_duration([]), 0)

    def test_frame_quantization_matches_output_timebase(self):
        clips = [{"source_id": "a", "start": 0, "end": 1.011},
                 {"source_id": "a", "start": 2, "end": 3.011}]
        self.assertEqual(output_duration(clips), 2)
        self.assertEqual(map_subtitles(clips, {"a": [{"start": 2, "end": 3, "text": "字"}]}),
                         [{"start": 1, "end": 2, "text": "字"}])


if __name__ == "__main__":
    unittest.main()
