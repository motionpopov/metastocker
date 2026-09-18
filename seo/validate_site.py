#!/usr/bin/env python3
"""Validate real rendered pages, reciprocal languages, schema and local links."""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import urlsplit, unquote
import xml.etree.ElementTree as ET
from locales import LANGUAGES

BASE='https://metastocker.net'


class Page(HTMLParser):
    def __init__(self):
        super().__init__();self.canon=[];self.alternates={};self.links=[];self.images=[];self.h1=0;self.lang=None;self.schemas=[];self.in_schema=False;self.script='';self.ids=set();self.title='';self.in_title=False
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if a.get('id'):self.ids.add(a['id'])
        if tag=='html':self.lang=a.get('lang')
        if tag=='title':self.in_title=True
        if tag=='h1':self.h1+=1
        if tag=='a' and 'href' in a:self.links.append(a['href'])
        if tag=='img':self.images.append(a)
        if tag=='link' and a.get('rel')=='canonical':self.canon.append(a['href'])
        if tag=='link' and a.get('rel')=='alternate':self.alternates[a['hreflang']]=a['href']
        if tag=='script' and a.get('type')=='application/ld+json':self.in_schema=True;self.script=''
    def handle_data(self,data):
        if self.in_schema:self.script+=data
        if self.in_title:self.title+=data
    def handle_endtag(self,tag):
        if tag=='script' and self.in_schema:self.schemas.append(json.loads(self.script));self.in_schema=False
        if tag=='title':self.in_title=False


def check(public,minimum=200):
    paths=[url.find('{*}loc').text.removeprefix(BASE) for url in ET.parse(public/'sitemap.xml').getroot()]
    if len(paths)!=len(set(paths)):raise ValueError('Duplicate sitemap URLs')
    pages={}
    for path in paths:
        file=public/path.lstrip('/')
        if path.endswith('/'):file/='index.html'
        page=Page();page.feed(file.read_text());pages[path]=page
        if page.canon!=[BASE+path]:raise ValueError('Canonical mismatch: '+path)
        if page.h1!=1 or not page.title or not page.schemas:raise ValueError('Missing title, H1 or schema: '+path)
    article_count=0
    for path,page in pages.items():
        if path.startswith('/blog/'):
            if set(page.alternates)!=set(LANGUAGES)|{'x-default'}:raise ValueError('Missing language links: '+path)
            for lang,url in page.alternates.items():
                peer=pages.get(url.removeprefix(BASE))
                if not peer or peer.alternates.get(page.lang)!=BASE+path:raise ValueError('Non-reciprocal hreflang: '+path)
                if lang!='x-default' and peer.lang!=lang:raise ValueError('Wrong language target: '+path)
            for image in page.images:
                if 'alt' not in image or not image.get('width') or not image.get('height'):raise ValueError('Incomplete image: '+path)
                if not (public/image['src'].lstrip('/')).is_file():raise ValueError('Missing illustration: '+path)
            for href in page.links:
                u=urlsplit(href)
                if u.netloc and u.netloc!='metastocker.net':continue
                if not u.path and u.fragment:
                    if unquote(u.fragment) not in page.ids:raise ValueError('Broken anchor: '+path)
                elif u.path.startswith('/'):
                    target=public/u.path.lstrip('/')
                    if u.path.endswith('/'):target/='index.html'
                    if not target.is_file():raise ValueError('Broken local link: '+path+' -> '+href)
            if isinstance(page.schemas[0],list) and page.schemas[0][0]['@type']=='BlogPosting':article_count+=1
    if article_count<minimum:raise ValueError(f'Expected at least {minimum} articles, got {article_count}')
    if (public/'blog/article-template.html').exists():raise ValueError('Template must not be public')
    return {'articles':article_count,'indexable_pages':len(pages),'languages':list(LANGUAGES)}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('public',type=Path);p.add_argument('--minimum',type=int,default=200);a=p.parse_args();print(json.dumps(check(a.public,a.minimum)))
