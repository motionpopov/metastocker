import copy
from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'seo'))
import publish_daily as publisher
from build_blog import load_posts
from translate_articles import source_hash


class PublisherBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        (self.base / 'current/public').mkdir(parents=True)
        (self.base / 'data').mkdir()
        (self.base / 'editorial').mkdir()
        self.release = dict(release='current-test', commit='a' * 40, editorial=dict(articles=200, topics=50))
        (self.base / 'current/public/release.json').write_text(json.dumps(self.release))
        self.patches = [patch.object(publisher, 'BASE', self.base), patch.object(publisher, 'STATE', self.base / 'editorial'), patch.object(publisher.os, 'chown')]
        for p in self.patches: p.start()
        self.addCleanup(self.temp.cleanup)
        for p in self.patches: self.addCleanup(p.stop)

    def previous(self, **data):
        (self.base / 'editorial/status.json').write_text(json.dumps(data))

    def test_successful_day_is_not_published_twice(self):
        self.previous(status='published', last_success=publisher.stamp(), last_topic='existing')
        with patch.object(publisher, 'write_one') as writer, patch.object(publisher.subprocess, 'run') as external:
            result = publisher.run()
        self.assertEqual(result['status'], 'already_published_today')
        writer.assert_not_called()
        external.assert_not_called()

    def test_retries_verification_after_activation_without_generating_another_topic(self):
        self.previous(status='failed', release='current-test', current_topic='recovered-topic')
        with patch.object(publisher, 'write_one') as writer, patch.object(publisher.subprocess, 'run') as external:
            result = publisher.run()
        self.assertEqual(result['status'], 'published')
        self.assertEqual(result['last_topic'], 'recovered-topic')
        self.assertEqual(external.call_count, 1)
        self.assertIn('verify_production.py', external.call_args.args[0][1])
        writer.assert_not_called()
        self.assertEqual(json.loads((self.base / 'data/editorial-status.json').read_text())['status'], 'published')

    def test_failed_editorial_review_never_becomes_public(self):
        original = copy.deepcopy(load_posts(ROOT)[0][0])
        def write(topic, destination, **kwargs):
            post = copy.deepcopy(original)
            post.update(slug=topic['slug'], category=topic['category'])
            (destination / (topic['slug'] + '.json')).write_text(json.dumps(post))
        def translated(post, output, **kwargs):
            return dict(bn=post['bn'], hi=post['hi'], source_hash=source_hash(post))
        def rejected(posts, output, **kwargs):
            return {'articles': [{'slug': posts[0]['slug'], 'approved': False, 'issues': ['Unsupported example claim']}]}
        with patch.object(publisher, 'refresh', return_value={}), patch.object(publisher, 'write_one', side_effect=write) as writer, patch.object(publisher, 'translate', side_effect=translated), patch.object(publisher, 'review', side_effect=rejected), patch.object(publisher.subprocess, 'run') as external:
            with self.assertRaisesRegex(RuntimeError, 'editorial_review_failed'): publisher.run()
        self.assertEqual(writer.call_count, 3)
        self.assertFalse(list((self.base / 'editorial/published').glob('*.json')))
        self.assertFalse((self.base / 'releases').exists())
        external.assert_not_called()
        self.assertEqual(json.loads((self.base / 'editorial/status.json').read_text())['status'], 'failed')

    def test_unverified_source_stops_before_generation(self):
        self.previous(status='failed', last_success=None)
        with patch.object(publisher, 'refresh', side_effect=ValueError('Unavailable official source')), patch.object(publisher, 'write_one') as writer:
            with self.assertRaises(ValueError): publisher.run()
        writer.assert_not_called()
        self.assertFalse(list((self.base / 'editorial/published').glob('*.json')))
        self.assertEqual(json.loads((self.base / 'editorial/status.json').read_text())['status'], 'failed')


if __name__ == '__main__': unittest.main()
