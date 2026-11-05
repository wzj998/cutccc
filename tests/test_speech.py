import unittest
from cutccc.speech import split_text

class SpeechTextTests(unittest.TestCase):
    def test_sentence_boundaries_keep_words_and_punctuation(self):
        text='第一句话。第二句话！Hello world? Last sentence.'
        parts=split_text(text)
        self.assertEqual(''.join(parts),text.replace('? ','?'))
        self.assertEqual(parts[0],'第一句话。')

    def test_long_sentence_is_bounded_without_dropping_characters(self):
        text='长句'*250
        parts=split_text(text)
        self.assertEqual(''.join(parts),text)
        self.assertTrue(all(len(part)<=160 for part in parts))

    def test_blank_input_has_no_audio_segments(self):
        self.assertEqual(split_text(' \n  '),[])

if __name__=='__main__':unittest.main()
