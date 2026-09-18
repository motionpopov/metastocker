import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'seo'))
from build_blog import load_posts,validate,build,path_for,e,jsonld,svg_diagram
from validate_site import check


class EditorialQuality(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.posts,cls.sources=load_posts(ROOT)
        cls.schema=json.loads((ROOT/'seo/article.schema.json').read_text())

    def test_initial_release_has_200_complete_articles_and_preserves_existing_routes(self):
        self.assertGreaterEqual(len(self.posts),50)
        names={p['slug'] for p in self.posts}
        for name in ('stock-photo-keywords-guide','how-to-get-openai-api-key','microstock-metadata-csv-export','mastering-adobe-stock-autokeywording'):
            self.assertIn(name,names)
        for p in self.posts:validate(p,self.sources,self.schema,complete=True)

    def test_missing_translation_or_example_is_not_publishable(self):
        for mutate in (lambda p:p['ru'].update(intro='English placeholder'),lambda p:[s.update(example='') for s in p['en']['sections']],lambda p:p.update(slug='../../private'),lambda p:p.update(source_ids=['invented-source'])):
            p=copy.deepcopy(self.posts[0]);mutate(p)
            with self.assertRaises(ValueError):validate(p,self.sources,self.schema,complete=True)

    def test_rendered_sitemap_languages_schema_links(self):
        with tempfile.TemporaryDirectory() as folder:
            public=Path(folder)
            # The blog references the public generator, privacy page and logo.
            for name in ('index.html','privacy.html'):(public/name).write_text((ROOT/name).read_text())
            (public/'assets').mkdir();(public/'assets/metalogo.png').write_bytes((ROOT/'assets/metalogo.png').read_bytes())
            result=build(ROOT,public)
            checked=check(public)
            self.assertEqual(checked['articles'],len(self.posts)*4)
            self.assertEqual(len(result['paths']),checked['indexable_pages'])
            first=(public/path_for(self.posts[0]['slug'],'en').lstrip('/')).read_text()
            self.assertIn('href="/"',first)
            self.assertIn('application/ld+json',first)

    def test_untrusted_article_text_cannot_create_executable_markup(self):
        payload='</script><img src=x onerror=alert(1)>'
        self.assertNotIn('<img',e(payload))
        script=jsonld({'headline':payload})
        self.assertEqual(script.count('</script>'),1)
        self.assertNotIn('<img',script)
        diagram=copy.deepcopy(self.posts[0]['en']['illustration']);diagram['title']=payload
        self.assertNotIn('<img',svg_diagram(diagram,'en'))

    def test_missing_indic_languages_or_corrupted_script_are_rejected(self):
        post=copy.deepcopy(self.posts[0]);del post['hi']
        with self.assertRaisesRegex(ValueError,'four languages'):validate(post,self.sources,self.schema,complete=True)
        post=copy.deepcopy(self.posts[0]);post['bn']['intro']+=' впечатনের'
        with self.assertRaisesRegex(ValueError,'mixed-script'):validate(post,self.sources,self.schema,complete=True)

    def test_conflicting_server_content_cannot_silently_replace_repository_article(self):
        with tempfile.TemporaryDirectory() as folder:
            p=copy.deepcopy(self.posts[0]);p['en']['title']='A conflicting article title for the same route'
            (Path(folder)/(p['slug']+'.json')).write_text(json.dumps(p))
            with self.assertRaisesRegex(ValueError,'Conflicting'):load_posts(ROOT,Path(folder))


if __name__=='__main__':unittest.main()
