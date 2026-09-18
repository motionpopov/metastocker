#!/usr/bin/env python3
"""Read-only public release, content, security-header and redirect checks."""
import argparse
import concurrent.futures
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from build_release import read_headers

ORIGIN = 'https://metastocker.net'
IP = '178.105.209.209'


def fetch(url):
    with tempfile.TemporaryDirectory(prefix='metastocker-http-') as folder:
        body, headers = Path(folder) / 'body', Path(folder) / 'headers'
        result = subprocess.run(['curl', '--silent', '--show-error', '--compressed', '--max-time', '40',
                                 '--output', str(body), '--dump-header', str(headers),
                                 '--write-out', '%{http_code} %{remote_ip}', url],
                                check=True, text=True, capture_output=True)
        status, remote = result.stdout.split()
        parsed = {}
        for line in headers.read_text().splitlines():
            if ':' in line:
                key, value = line.split(':', 1)
                parsed[key.lower()] = value.strip()
        return int(status), remote, parsed, body.read_bytes()


def verify(release=None, commit=None):
    status, remote, headers, body = fetch(ORIGIN + '/release.json')
    assert status == 200 and remote == IP, (status, remote)
    metadata = json.loads(body)
    assert not release or metadata['release'] == release, metadata
    assert not commit or metadata['commit'] == commit, metadata
    assert headers.get('x-metastocker-release') == metadata['release']
    assert headers.get('x-metastocker-host') == 'vintage-shop-prod'
    expected_headers = metadata['headers']
    if commit:
        assert expected_headers == read_headers(Path(__file__).resolve().parent.parent)

    def asset(item):
        name, checksum = item
        status, remote, headers, body = fetch(ORIGIN + '/' + name)
        assert status == 200 and remote == IP, (name, status, remote)
        assert hashlib.sha256(body).hexdigest() == checksum, name
        for header, value in expected_headers.items():
            assert headers.get(header.lower()) == value, (name, header)
        if name.endswith(('.js', '.mjs')):
            assert 'javascript' in headers.get('content-type', ''), name
        assert 'cross-origin-embedder-policy' not in headers, name
        return name

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        files = list(executor.map(asset, metadata['files'].items()))
    for url in ('http://metastocker.net/blog/?qa=1', 'http://www.metastocker.net/blog/?qa=1',
                'https://www.metastocker.net/blog/?qa=1'):
        status, remote, headers, _ = fetch(url)
        assert status in (301, 308) and remote == IP, (url, status, remote)
        assert headers.get('location') == ORIGIN + '/blog/?qa=1', (url, headers)
    for path in ('/', '/blog/', '/blog/how-to-get-openai-api-key'):
        status, remote, _, _ = fetch(ORIGIN + path)
        assert status == 200 and remote == IP, (path, status, remote)
    for path in ('/.git/config', '/.env', '/_headers', '/AGENTS.md', '/README.md',
                 '/deploy/compose.yaml', '/tests/local-ai.test.js', '/not-a-page'):
        status, _, _, _ = fetch(ORIGIN + path)
        assert status == 404, (path, status)
    return dict(release=metadata['release'], commit=metadata['commit'], version=metadata['version'],
                remote_ip=remote, verified_files=len(files), checks='HTTPS, hashes, headers, MIME, redirects, blog, private-file 404')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--release')
    parser.add_argument('--commit')
    args = parser.parse_args()
    print(json.dumps(verify(args.release, args.commit), indent=2))
