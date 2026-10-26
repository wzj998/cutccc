import unittest

from cutccc.recognition import (alignment_language, choose_hypothesis, combine_pass_cues, merge_ranges,
                                review_text, timed_cues, uncovered_speech)
from cutccc.subtitles import validate_cues


class RecognitionTests(unittest.TestCase):
    def test_english_is_returned_unchanged(self):
        text = "Please be extra careful with the rear wheels."
        candidates = [dict(text=text, language="English", variant=v) for v in ("original", "speech_band")]
        chosen, issues = choose_hypothesis(candidates)
        self.assertEqual(chosen["text"], text)
        self.assertEqual(issues, [])
        self.assertEqual(alignment_language(text, "English"), "English")
        self.assertEqual(alignment_language("好的，let's go.", "Chinese,English"), "Chinese")
        self.assertEqual(alignment_language("慢慢嚟", "Cantonese"), "Cantonese")

    def test_language_conflicts_are_not_forcibly_translated(self):
        selected, issues = choose_hypothesis([dict(text="Onbekende woorden", language="Dutch", variant="original")])
        self.assertIsNone(selected)
        self.assertTrue(issues)

    def test_conflicting_and_single_pass_results_are_reported(self):
        selected, issues = choose_hypothesis([
            dict(text="Keep to the right", language="English", variant="original"),
            dict(text="这是什么情况", language="Chinese", variant="speech_band"),
        ])
        self.assertIsNotNone(selected)
        self.assertTrue(issues)
        selected, issues = choose_hypothesis([
            dict(text="", language="", variant="original"),
            dict(text="Hello", language="English", variant="speech_band"),
        ])
        self.assertEqual(selected["text"], "Hello")
        self.assertTrue(issues)

    def test_zero_timestamps_merge_only_into_measured_phrase_spans(self):
        words = [dict(text="OK", display="OK, ", start=1, end=1),
                 dict(text="go", display="go.", start=1, end=2)]
        cues, issues = timed_cues(words, max_chars=54)
        self.assertEqual(cues, [dict(start=1, end=2, text="OK, go.")])
        self.assertTrue(issues)
        validate_cues(cues, 3)
        cues, issues = timed_cues([dict(text="noise", display="noise.", start=1, end=1)])
        self.assertEqual(cues, [])
        self.assertTrue(issues)

    def test_uncovered_speech_reports_only_measurable_gaps(self):
        speech = [dict(start=0, end=10)]
        gaps = uncovered_speech(speech, [dict(start=2, end=4), dict(start=6, end=9)], padding=0)
        self.assertEqual(gaps, [dict(start=0, end=2), dict(start=4, end=6), dict(start=9, end=10)])
        self.assertEqual(uncovered_speech(speech, [dict(start=0, end=10)]), [])
        self.assertEqual(merge_ranges([dict(start=0, end=2), dict(start=1, end=3)]), [dict(start=0, end=3)])

    def test_review_export_keeps_candidates_and_source_timestamps(self):
        text = review_text([dict(start=12, end=14, status="uncertain", reasons=["需要复听"],
                   candidates=[dict(text="Original English words.", language="English", variant="original")])])
        self.assertIn("00:00:12,000", text)
        self.assertIn("Original English words.", text)

    def test_speech_focused_pass_replaces_broad_scan_but_keeps_ungated_scan(self):
        scan=dict(scope="scan",offset=0,duration=12,review_reasons=[],cues=[
             dict(start=1,end=3,text="Keep this"),dict(start=6,end=9,text="Unclear broad scan")])
        focused=dict(scope="speech",offset=5,duration=5,text="Original English speech",review_reasons=[],cues=[dict(start=6,end=9,text="Original English speech")])
        self.assertEqual([c["text"] for c in combine_pass_cues([scan,focused])],["Keep this","Original English speech"])

    def test_short_pass_language_conflict_does_not_replace_chinese_with_english(self):
        scan=dict(scope="scan",offset=0,duration=12,text="我们回去换人",review_reasons=[],cues=[dict(start=1,end=3,text="我们回去换人")])
        focused=dict(scope="speech",offset=0,duration=4,text="You're in first",review_reasons=[],cues=[dict(start=1,end=3,text="You're in first")])
        self.assertEqual(combine_pass_cues([scan,focused]),scan["cues"])
        self.assertTrue(focused["review_reasons"])

    def test_word_differences_are_reported_even_when_languages_match(self):
        _, issues = choose_hypothesis([
            dict(text="I saw it now.", language="English", variant="original"),
            dict(text="I see it now.", language="English", variant="speech_band"),
        ])
        self.assertTrue(issues)
        scan=dict(scope="scan",offset=0,duration=12,text="I saw it now.",review_reasons=[],cues=[dict(start=1,end=3,text="I saw it now.")])
        focused=dict(scope="speech",offset=0,duration=4,text="I see it now.",review_reasons=[],cues=[dict(start=1,end=3,text="I see it now.")])
        combine_pass_cues([scan,focused])
        self.assertTrue(focused["review_reasons"])
