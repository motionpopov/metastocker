import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'seo'))
from repair_articles import apply_edits


class EditorialRepair(unittest.TestCase):
    def setUp(self):
        self.article = {
            'slug': 'preserve-route', 'source_ids': ['official-source'], 'published': '2026-09-18',
            'en': {'title': 'Original title', 'sections': [{'paragraphs': ['Source text.']}]},
            'ru': {'title': 'Исходный заголовок', 'sections': [{'paragraphs': ['Неточный перевод.']}]},
            'bn': {'title': 'মূল শিরোনাম'}, 'hi': {'title': 'मूल शीर्षक'},
        }

    def test_repairs_one_field_and_preserves_all_other_text_and_metadata(self):
        original = copy.deepcopy(self.article)
        changed = apply_edits(self.article, [{'path': '/ru/sections/0/paragraphs/0', 'before': 'Неточный перевод.', 'after': 'Исправленный перевод.'}])
        expected = copy.deepcopy(original)
        expected['ru']['sections'][0]['paragraphs'][0] = 'Исправленный перевод.'
        self.assertEqual(changed, expected)
        self.assertEqual(self.article, original)

    def test_cannot_change_route_sources_dates_or_nonexistent_fields(self):
        for path, before in [('/slug', 'preserve-route'), ('/source_ids/0', 'official-source'), ('/published', '2026-09-18'), ('/ru/new-field', '')]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                apply_edits(self.article, [{'path': path, 'before': before, 'after': 'Changed'}])

    def test_stale_or_repeated_replacements_are_rejected(self):
        edit = {'path': '/en/title', 'before': 'Original title', 'after': 'Corrected title'}
        with self.assertRaises(ValueError): apply_edits(self.article, [dict(edit, before='Stale title')])
        with self.assertRaises(ValueError): apply_edits(self.article, [edit, edit])


if __name__ == '__main__': unittest.main()
