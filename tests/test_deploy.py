import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_release', ROOT / 'deploy/build_release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeploymentSafety(unittest.TestCase):
    def test_public_package_preserves_assets_and_excludes_repository_internals(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'release'
            metadata = module.build(ROOT, output, 'test-release', 'a' * 40)
            public = output / 'public'
            self.assertEqual((public / 'local-ai-worker.mjs').read_bytes(), (ROOT / 'local-ai-worker.mjs').read_bytes())
            for name in ('.git', 'deploy', 'tests', 'server', 'data', 'secrets', 'AGENTS.md', '_headers', 'README.md'):
                self.assertFalse((public / name).exists(), name)
            self.assertIn('blog/how-to-get-openai-api-key.html', metadata['files'])
            self.assertIn('https://metastocker.net/blog/', (public / 'sitemap.xml').read_text())
            config = (output / 'Staticfile').read_text()
            self.assertIn('reverse_proxy metastocker-analytics:8081', config)
            self.assertIn('header_up X-Forwarded-For {http.request.header.X-Forwarded-For}', config)
            self.assertNotIn('@RELEASE@', (output / 'deploy/compose.yaml').read_text())
            self.assertTrue((output / 'server/pages.json').exists())
            self.assertFalse((output / 'server/node_modules').exists())
            for value in module.read_headers(ROOT).values():
                self.assertIn(value, config)
            # The remote verifier imports its dependencies from the packaged source snapshot.
            result = subprocess.run([sys.executable, str(output / 'deploy/verify_production.py'), '--help'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_unsafe_release_names_are_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            for release in ('../shared', '/etc/caddy', 'bad; command', ''):
                with self.assertRaises(ValueError):
                    module.build(ROOT, Path(folder) / 'output', release, 'a' * 40)

    def test_new_netlify_rules_cannot_be_silently_dropped(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source'
            source.mkdir()
            shutil.copyfile(ROOT / '_headers', source / '_headers')
            (source / '_redirects').write_text('/old /new 301\n')
            with self.assertRaisesRegex(ValueError, 'Translate _redirects'):
                module.build(source, Path(folder) / 'output', 'test', 'a' * 40)
            (source / '_headers').write_text('/admin/*\n  X-Frame-Options: DENY\n')
            with self.assertRaisesRegex(ValueError, 'path rules'):
                module.read_headers(source)
