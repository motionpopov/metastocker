#!/usr/bin/env python3
"""Package only public assets; translate the repository's Netlify headers."""
import argparse
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

PUBLIC_FILES = ('index.html', 'app.js', 'local-ai.js', 'local-ai-worker.mjs',
                'style.css', 'tailwind.generated.css', 'robots.txt')


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


def build(source, output, release, commit):
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
    for directory in ('assets', 'blog'):
        for path in sorted((source / directory).rglob('*')):
            relative = path.relative_to(source)
            if path.is_symlink() or any(part.startswith('.') for part in relative.parts):
                raise ValueError(f'Unexpected private file or symlink: {relative}')
            if path.is_file():
                target = public / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
    sitemap_paths = ['/', '/blog/'] + [f'/blog/{p.name}' for p in sorted((public / 'blog').glob('*.html'))
                                     if p.name not in ('index.html', 'article-template.html')]
    sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    sitemap += ''.join(f'  <url><loc>{escape("https://metastocker.net" + path)}</loc></url>\n' for path in sitemap_paths)
    (public / 'sitemap.xml').write_text(sitemap + '</urlset>\n')
    hashes = {str(p.relative_to(public)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(public.rglob('*')) if p.is_file()}
    version = re.search(r'class="badge version-badge">v([^<]+)', (public / 'index.html').read_text()).group(1)
    metadata = dict(release=release, commit=commit, version=version, headers=headers,
                    built_at=datetime.now(timezone.utc).isoformat(), files=hashes)
    (public / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
    static = '{\n\tauto_https off\n\tpersist_config off\n}\n:8080 {\n'
    static += f'\troot * /srv/metastocker/releases/{release}/public\n\theader {{\n'
    for name, value in headers.items():
        static += f'\t\t{name} {json.dumps(value)}\n'
    static += f'\t\tX-MetaStocker-Release "{release}"\n\t\tX-MetaStocker-Host "vintage-shop-prod"\n'
    static += '\t\tCache-Control "public, max-age=0, must-revalidate"\n\t}\n'
    static += '\t@modules path *.mjs\n\theader @modules Content-Type "text/javascript; charset=utf-8"\n'
    static += '\t@wasm path *.wasm\n\theader @wasm Content-Type "application/wasm"\n'
    static += '\ttry_files {path} {path}.html\n\tfile_server\n}\n'
    (output / 'Staticfile').write_text(static)
    shutil.copytree(source / 'deploy', output / 'deploy', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    manifest = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(output)}\n'
                       for p in sorted(output.rglob('*')) if p.is_file())
    (output / 'SHA256SUMS').write_text(manifest)
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for argument in ('source', 'output', 'release', 'commit'):
        parser.add_argument('--' + argument, required=True)
    args = parser.parse_args()
    print(json.dumps(build(Path(args.source), Path(args.output), args.release, args.commit), indent=2))
