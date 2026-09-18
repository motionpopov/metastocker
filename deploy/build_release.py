#!/usr/bin/env python3
"""Package only public assets; translate the repository's Netlify headers."""
import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

code_root = Path(__file__).resolve().parents[1]
if not (code_root / 'seo').is_dir():
    code_root /= 'source'
sys.path.insert(0, str(code_root / 'seo'))
from build_blog import build as build_blog

PUBLIC_FILES = ('index.html', 'app.js', 'local-ai.js', 'local-ai-worker.mjs',
                'style.css', 'tailwind.generated.css', 'robots.txt',
                'analytics.js', 'privacy.html', 'privacy.css', 'privacy.js', 'blog.css')


def read_headers(source):
    headers = {}
    scope = None
    for line in (source / '_headers').read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if not line[0].isspace():
            scope = line.strip()
            if scope != '/*':
                raise ValueError('Translate new _headers path rules before deploying')
        else:
            name, value = line.strip().split(':', 1)
            if scope != '/*' or not re.fullmatch(r'[A-Za-z0-9-]+', name):
                raise ValueError('Invalid or unsupported _headers rule')
            headers[name] = value.strip()
    if 'Content-Security-Policy' not in headers:
        raise ValueError('Content-Security-Policy is required')
    return headers


def build(source, output, release, commit, extra=None):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}', release):
        raise ValueError('Unsafe release name')
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('A full Git commit is required')
    for config in ('_redirects', 'netlify.toml'):
        if (source / config).exists() and (source / config).read_text().strip():
            raise ValueError(f'Translate {config} explicitly before deploying')
    headers = read_headers(source)
    public = output / 'public'
    public.mkdir(parents=True, exist_ok=False)
    for name in PUBLIC_FILES:
        shutil.copyfile(source / name, public / name)
    for directory in ('assets',):
        for path in sorted((source / directory).rglob('*')):
            relative = path.relative_to(source)
            if path.is_symlink() or any(part.startswith('.') for part in relative.parts):
                raise ValueError(f'Unexpected private file or symlink: {relative}')
            if path.is_file():
                target = public / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
    editorial = build_blog(source, public, extra)
    hashes = {str(p.relative_to(public)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(public.rglob('*')) if p.is_file()}
    version = re.search(r'class="badge version-badge">v([^<]+)', (public / 'index.html').read_text()).group(1)
    metadata = dict(release=release, commit=commit, version=version, headers=headers,
                    built_at=datetime.now(timezone.utc).isoformat(), files=hashes,
                    editorial={k: editorial[k] for k in ('articles', 'topics', 'content_hash')})
    (public / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
    static = '{\n\tauto_https off\n\tpersist_config off\n}\n:8080 {\n'
    static += f'\troot * /srv/metastocker/releases/{release}/public\n\theader {{\n'
    for name, value in headers.items():
        static += f'\t\t{name} {json.dumps(value)}\n'
    static += f'\t\tX-MetaStocker-Release "{release}"\n\t\tX-MetaStocker-Host "vintage-shop-prod"\n'
    static += '\t\t?Cache-Control "public, max-age=0, must-revalidate"\n\t}\n'
    static += '\t@modules path *.mjs\n\theader @modules Content-Type "text/javascript; charset=utf-8"\n'
    static += '\t@wasm path *.wasm\n\theader @wasm Content-Type "application/wasm"\n'
    # Keep existing article URLs and redirect aliases to one indexable address.
    static += '\tredir /index.html / 308\n\tredir /blog/article-template.html /blog/ 308\n'
    for path in editorial['paths']:
        if path.endswith('/') and path != '/':
            static += f'\tredir {path}index.html {path} 308\n'
        elif path.endswith('.html'):
            static += f'\tredir {path[:-5]} {path} 308\n'
    static += '\t@analytics path /api/analytics /admin /admin/*\n'
    static += '\thandle @analytics {\n\t\theader Cache-Control "no-store"\n\t\treverse_proxy metastocker-analytics:8081 {\n'
    static += '\t\t\theader_up X-Forwarded-For {http.request.header.X-Forwarded-For}\n\t\t}\n\t}\n'
    static += '\thandle {\n\t\ttry_files {path} {path}.html\n\t\tfile_server\n\t}\n}\n'
    (output / 'Staticfile').write_text(static)
    shutil.copytree(source / 'deploy', output / 'deploy', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    compose = output / 'deploy/compose.yaml'
    compose.write_text(compose.read_text().replace('@RELEASE@', release))
    shutil.copytree(source / 'server', output / 'server',
                    ignore=shutil.ignore_patterns('node_modules', '*.sqlite*', '__pycache__'))
    pages = editorial['paths']
    (output / 'server/pages.json').write_text(json.dumps(pages) + '\n')
    (output / 'server/editorial.json').write_text(json.dumps(metadata['editorial']) + '\n')
    # Complete, private build inputs let the server publish without a mutable Git checkout.
    snapshot = output / 'source'
    snapshot.mkdir()
    for name in PUBLIC_FILES + ('_headers', 'AGENTS.md'):
        shutil.copyfile(source / name, snapshot / name)
    for directory in ('assets', 'seo', 'content', 'server', 'deploy'):
        shutil.copytree(source / directory, snapshot / directory,
                        ignore=shutil.ignore_patterns('node_modules', '__pycache__', '*.pyc', '*.sqlite*'))
    if extra:
        for post in extra.glob('*.json'):
            shutil.copyfile(post, snapshot / 'content/posts' / post.name)
    (output / 'content-snapshot.json').write_text(json.dumps({p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (snapshot / 'content/posts').glob('*.json')}, sort_keys=True) + '\n')
    manifest = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(output)}\n'
                       for p in sorted(output.rglob('*')) if p.is_file())
    (output / 'SHA256SUMS').write_text(manifest)
    # Portable rsync on macOS does not accept GNU-style --chmod=D755,F644.
    output.chmod(0o755)
    for path in output.rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o644)
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for argument in ('source', 'output', 'release', 'commit'):
        parser.add_argument('--' + argument, required=True)
    parser.add_argument('--extra', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(Path(args.source), Path(args.output), args.release, args.commit, args.extra), indent=2))
