#!/usr/bin/env python3
"""Build crawlable, multilingual editorial pages from validated plain-text content."""
import argparse
from datetime import date
from difflib import SequenceMatcher
import hashlib
from html import escape
import json
import math
from pathlib import Path
import re
import textwrap
import unicodedata
from xml.sax.saxutils import escape as xml_escape
from locales import LANGUAGES, UI, CATEGORY_EXTRA, EDITORIAL_EXTRA

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://metastocker.net'
CATEGORIES = {
    'metadata': ('Titles & keywords', 'Названия и ключевые слова', 'Describe what buyers can actually see. Work through original examples of titles, keyword order, visual details and unsupported guesses.', 'Описывайте то, что покупатель действительно увидит. Примеры названий, порядка ключевых слов и проверки фактов помогут убрать необоснованные догадки.'),
    'platforms': ('Stock platforms', 'Стоковые платформы', 'Adapt a reviewed draft to each marketplace. These guides separate shared metadata principles from platform-specific requirements.', 'Адаптируйте проверенный текст к конкретному стоку. Здесь общие принципы работы с метаданными отделены от требований отдельных платформ.'),
    'exports': ('CSV & exports', 'CSV и экспорт', 'Check filenames, columns, quoting and import results. A downloaded CSV is one step in preparing a submission, and the receiving platform needs its own review.', 'Проверьте имена файлов, столбцы, кавычки и результат импорта. Скачивание CSV — один из этапов подготовки; результат на стороне стока нужно проверить отдельно.'),
    'local-ai': ('Local AI', 'Локальный AI', 'Choose, load and test vision models in your browser. Understand memory, model downloads, parallel processing and the limits of automatic descriptions.', 'Выбирайте, загружайте и проверяйте vision-модели в браузере. Разберитесь в памяти, кеше, параллельной обработке и ограничениях автоматических описаний.'),
    'workflow': ('Contributor workflow', 'Работа автора', 'Build a repeatable path from shoot notes to reviewed metadata. Organize batches and preserve the connection between each asset and its exported row.', 'Выстройте понятный путь от заметок о съёмке до проверенных метаданных. Организуйте пакеты и сохраняйте связь каждого файла со строкой экспорта.'),
    'seo': ('Portfolio SEO', 'SEO портфолио', 'Help readers and search engines understand your own photography website. Keep Google indexing, stock marketplace discovery and useful business outcomes separate.', 'Помогите читателям и поисковикам понять ваш фотосайт. Различайте индексацию Google, поиск внутри стоков и полезные для автора результаты.')
}


def e(value):
    return escape(str(value), quote=True)


def path_for(slug, lang):
    return home(lang) + slug + '.html'


def home(lang):
    return '/blog/' + (lang + '/' if lang != 'en' else '')


def category_text(category, lang, description=False):
    if lang in CATEGORY_EXTRA:
        return CATEGORY_EXTRA[lang][category][int(description)]
    return CATEGORIES[category][(2 if description else 0) + (lang == 'ru')]


def language_paths(suffix):
    paths = {lang: home(lang) + suffix for lang in LANGUAGES}
    return dict(paths, **{'x-default': paths['en']})


def words(article):
    text = article['intro'] + ' ' + ' '.join(article['checklist'])
    for section in article['sections']:
        text += ' ' + ' '.join(section['paragraphs'] + section['bullets']) + ' ' + section['example']
    return text.split()


def schema_check(value, schema, location='article'):
    kind = schema['type']
    if kind == 'object':
        if not isinstance(value, dict) or set(value) != set(schema['required']):
            raise ValueError(f'{location}: unexpected or missing fields')
        for key, spec in schema['properties'].items():
            schema_check(value[key], spec, location + '.' + key)
    elif kind == 'array':
        if not isinstance(value, list) or len(value) > 30:
            raise ValueError(f'{location}: invalid array')
        for item in value:
            schema_check(item, schema['items'], location)
    elif not isinstance(value, str) or len(value) > 12000 or '\x00' in value:
        raise ValueError(f'{location}: invalid text')


def validate(post, sources, schema, topic=None, complete=False):
    body = {k: v for k, v in post.items() if k not in ('published', 'modified', 'bn', 'hi')}
    schema_check(body, schema)
    if complete and any(lang not in post for lang in LANGUAGES):
        raise ValueError('A publication requires all four languages')
    for lang in ('bn', 'hi'):
        if lang in post: schema_check(post[lang], schema['properties']['en'], lang)
    if not re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*', post['slug']) or post['category'] not in CATEGORIES:
        raise ValueError('Invalid slug/category')
    if topic and (post['slug'] != topic['slug'] or post['category'] != topic['category']):
        raise ValueError('Topic assignment mismatch')
    if not 1 <= len(post['source_ids']) <= 5 or any(s not in sources for s in post['source_ids']):
        raise ValueError('Invalid sources')
    for field in ('published', 'modified'):
        if date.fromisoformat(post[field]) > date.today():
            raise ValueError('Future publication date')
    if post['modified'] < post['published']:
        raise ValueError('Invalid modified date')
    for lang in (code for code in LANGUAGES if code in post):
        a = post[lang]
        if not 15 <= len(a['title']) <= 105 or not 70 <= len(a['description']) <= 210:
            raise ValueError(lang + ': title/description length')
        if not 370 <= len(words(a)) <= 2000:
            raise ValueError(f'{lang}: expected substantive article, got {len(words(a))} words')
        if not 5 <= len(a['sections']) <= 9 or not 4 <= len(a['checklist']) <= 10:
            raise ValueError(lang + ': sections/checklist')
        if not any(len(s['example']) > 50 for s in a['sections']):
            raise ValueError(lang + ': missing worked example')
        if len(set(s['heading'].casefold() for s in a['sections'])) != len(a['sections']):
            raise ValueError(lang + ': repeated section headings')
        if lang == 'ru' and len(re.findall('[а-яА-ЯёЁ]', a['intro'])) < 40:
            raise ValueError('Russian translation missing')
        script = {'bn': '[\u0980-\u09ff]', 'hi': '[\u0900-\u097f]'}.get(lang)
        if script and len(re.findall(script, a['intro'])) < 40:
            raise ValueError(lang + ': native-script translation missing')
        if script:
            prose=' '.join([a['title'],a['description'],a['intro'],*a['checklist'],*[s['heading']+' '+' '.join(s['paragraphs']+s['bullets']) for s in a['sections']]])
            latin=len(re.findall('[A-Za-z]',prose)); native=len(re.findall(script,prose))
            if latin / max(1,latin+native) > .30:
                raise ValueError(lang + ': too much untranslated English prose')
            mixed=re.finditer('[а-яёА-ЯЁ][\u0980-\u09ff\u0900-\u097f]|[\u0980-\u09ff\u0900-\u097f][а-яёА-ЯЁ]', ' '.join(words(a)))
            if any(all(unicodedata.category(c)[0] in 'LM' for c in match.group()) for match in mixed):
                raise ValueError(lang + ': corrupted mixed-script word')
        diagram = a['illustration']
        if len(diagram['steps']) != 3 or len(diagram['title']) > 95:
            raise ValueError(lang + ': invalid illustration')
        if any(len(s['label']) > 48 or len(s['detail']) > 115 for s in diagram['steps']):
            raise ValueError(lang + ': illustration labels too long')
        text = ' '.join(words(a))
        if re.search(r'guaranteed (?:sales|rankings)|rank (?:number|#) ?1|гарантируем (?:продажи|рост)|lorem ipsum', text, re.I):
            raise ValueError(lang + ': unsupported claim/placeholder')
    return post


def load_topics(source, extra=None):
    topics = {}
    files = [source / 'content/topics.json', source / 'content/posts/_topics.json']
    if extra: files.append(extra / '_topics.json')
    for file in files:
        if not file.exists(): continue
        if file.is_symlink() or file.stat().st_size > 5_000_000: raise ValueError('Unsafe topic catalog')
        rows = json.loads(file.read_text())
        if not isinstance(rows, list): raise ValueError('Invalid topic catalog')
        for topic in rows:
            if set(topic) != {'slug','category','intent','brief','initial','order'}:
                raise ValueError('Invalid topic fields')
            slug = topic['slug']
            if not re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*',slug) or len(slug)>100 or topic['category'] not in CATEGORIES:
                raise ValueError('Invalid topic route')
            if not isinstance(topic['order'],int) or not 0 < topic['order'] < 10000:
                raise ValueError('Invalid topic order')
            if any(not isinstance(topic[k],str) or not 10 <= len(topic[k]) <= 2500 for k in ('intent','brief')):
                raise ValueError('Invalid topic brief')
            if slug in topics and topics[slug] != topic: raise ValueError('Conflicting topic: '+slug)
            topics[slug] = topic
    return sorted(topics.values(),key=lambda t:t['order'])


def load_posts(source, extra=None):
    sources = json.loads((source / 'seo/sources.json').read_text())
    schema = json.loads((source / 'seo/article.schema.json').read_text())
    topics = {t['slug']: t for t in load_topics(source,extra)}
    posts = {}
    folders = [source / 'content/posts'] + ([extra] if extra else [])
    for folder in folders:
        for f in sorted(folder.glob('*.json')):
            if f.name == '_topics.json': continue
            if f.is_symlink() or f.stat().st_size > 250000:
                raise ValueError('Unsafe content file')
            post = json.loads(f.read_text())
            if post['slug'] != f.stem or f.stem not in topics:
                raise ValueError('Unknown article route: ' + f.stem)
            validate(post, sources, schema, topics[f.stem], complete=True)
            if f.stem in posts and post != posts[f.stem]:
                raise ValueError('Conflicting durable and repository content: ' + f.stem)
            posts[f.stem] = post
    result = sorted(posts.values(), key=lambda p: (-date.fromisoformat(p['published']).toordinal(), topics[p['slug']]['order']))
    for lang in LANGUAGES:
        titles = [p[lang]['title'].casefold() for p in result]
        if len(titles) != len(set(titles)):
            raise ValueError('Duplicate article titles')
        # Compare substantial original text, excluding shared site navigation and CTAs.
        shingles = []
        for p in result:
            tokens = [w.casefold() for w in words(p[lang])]
            current = {tuple(tokens[i:i+6]) for i in range(len(tokens)-5)}
            for slug, previous in shingles:
                if len(current & previous) / max(1, min(len(current), len(previous))) > .35:
                    raise ValueError('Near-duplicate articles: ' + slug + ', ' + p['slug'])
            shingles.append((p['slug'], current))
    return result, sources


def jsonld(data):
    return '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False).replace('<', '\\u003c') + '</script>'


def head(title, description, path, lang, alternates, data, image='/assets/metalogo.png'):
    links = ''.join(f'<link rel="alternate" hreflang="{code}" href="{BASE}{url}">' for code, url in alternates.items())
    return f'''<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)} · MetaStocker</title><meta name="description" content="{e(description)}"><link rel="canonical" href="{BASE}{path}">{links}
<meta property="og:type" content="{'article' if isinstance(data, list) else 'website'}"><meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(description)}"><meta property="og:url" content="{BASE}{path}"><meta property="og:image" content="{BASE}{image}"><meta property="og:locale" content="{dict(en='en_US',ru='ru_RU',bn='bn_BD',hi='hi_IN')[lang]}"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/metalogo.png"><link rel="stylesheet" href="/assets/fonts/blog-fonts.css"><link rel="stylesheet" href="/blog.css">{jsonld(data)}<script src="/analytics.js?v=2.12" defer></script></head><body><a class="skip" href="#main">{UI[lang]["skip"]}</a>'''


def navigation(lang, alternates):
    languages = '<details class="language-menu"><summary>' + LANGUAGES[lang] + '</summary><ul>'
    for code, label in LANGUAGES.items():
        languages += f'<li><a href="{alternates[code]}" lang="{code}" hreflang="{code}"'+(' aria-current="true"' if code == lang else '')+f'>{label}</a></li>'
    languages += '</ul></details>'
    return f'''<header class="site-header"><div class="wide header-inner"><a href="/" class="brand"><img src="/assets/metalogo.png" alt="" width="32" height="32">MetaStocker</a><nav aria-label="{UI[lang]['navigation']}"><a href="{home(lang)}">{UI[lang]['guides']}</a>{languages}<a class="button small" href="/">{UI[lang]['generator']}</a></nav></div></header>'''


def footer(lang):
    return f'''<footer class="wide footer"><span>MetaStocker · {UI[lang]['footer']}</span><div><a href="{home(lang)}editorial.html">{UI[lang]['editorial']}</a><a href="/privacy.html">{UI[lang]['privacy']}</a><a href="/sitemap.xml">Sitemap</a></div></footer></body></html>'''


def cta(lang):
    note={'en':'','ru':'Интерфейс генератора — на английском.','bn':'জেনারেটরের ইন্টারফেস ইংরেজিতে।','hi':'जनरेटर का इंटरफ़ेस अंग्रेज़ी में है।'}[lang]
    return f'''<aside class="cta"><div><p class="eyebrow">MetaStocker</p><h2>{UI[lang]['cta_title']}</h2><p>{UI[lang]['cta_text']} {note}</p></div><a class="button" href="/">{UI[lang]['cta_button']}</a></aside>'''


def svg_diagram(diagram, lang):
    def lines(text, x, y, size, width, color):
        wrapped = textwrap.wrap(text, width, break_long_words=False)
        return ''.join(f'<text x="{x}" y="{y+i*(size+8)}" fill="{color}" font-size="{size}">{e(line)}</text>' for i, line in enumerate(wrapped))
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="540" viewBox="0 0 1200 540" role="img">', f'<title>{e(diagram["title"])}</title>', '<rect width="1200" height="540" rx="28" fill="#f0edfc"/>', '<g font-family="Arial, sans-serif">', '<text x="50" y="55" font-size="18" fill="#5b3ee8">METASTOCKER / FIELD NOTES</text>']
    parts.append(lines(diagram['title'], 50, 108, 30, 61, '#232037'))
    for i, step in enumerate(diagram['steps']):
        x = 50 + i*374
        parts.append(f'<rect x="{x}" y="200" width="352" height="285" rx="18" fill="white"/>')
        parts.append(f'<circle cx="{x+39}" cy="242" r="20" fill="#5b3ee8"/><text x="{x+33}" y="249" fill="white" font-size="19">{i+1}</text>')
        parts.append(lines(step['label'], x+24, 305, 24, 22, '#232037'))
        parts.append(lines(step['detail'], x+24, 385, 19, 28, '#676b7a'))
    return ''.join(parts) + '</g></svg>'


def write(public, path, text):
    target = public / path.lstrip('/')
    if path.endswith('/'):
        target /= 'index.html'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def build(source, public, extra=None):
    posts, sources = load_posts(source, extra)
    if not posts:
        raise ValueError('No articles to publish')
    entries = [dict(path='/')]
    for p in posts:
        alternates = {lang: path_for(p['slug'], lang) for lang in LANGUAGES}
        alternates['x-default'] = alternates['en']
        for lang in LANGUAGES:
            a = p[lang]; path = alternates[lang]
            category = category_text(p['category'], lang)
            category_path = home(lang) + 'topics/' + p['category'] + '/'
            img = '/assets/guides/' + p['slug'] + '-' + lang + '.svg'
            write(public, img, svg_diagram(a['illustration'], lang))
            data = [{'@context':'https://schema.org','@type':'BlogPosting','headline':a['title'],'description':a['description'],'inLanguage':lang,'datePublished':p['published'],'dateModified':p['modified'],'mainEntityOfPage':BASE+path,'image':BASE+img,'author':{'@type':'Organization','name':'MetaStocker','url':BASE+home(lang)+'editorial.html'},'publisher':{'@type':'Organization','name':'MetaStocker','url':BASE,'logo':{'@type':'ImageObject','url':BASE+'/assets/metalogo.png'}}}, {'@context':'https://schema.org','@type':'BreadcrumbList','itemListElement':[{'@type':'ListItem','position':1,'name':'MetaStocker','item':BASE},{'@type':'ListItem','position':2,'name':UI[lang]["guides"],'item':BASE+home(lang)},{'@type':'ListItem','position':3,'name':category,'item':BASE+category_path},{'@type':'ListItem','position':4,'name':a['title'],'item':BASE+path}]}]
            html = head(a['title'], a['description'], path, lang, alternates, data, img) + navigation(lang, alternates)
            intro = ''.join('<p class="dek">'+e(t)+'</p>' for t in a['intro'].split('\n\n'))
            html += f'<main id="main" class="article"><nav class="breadcrumbs" aria-label="{dict(en="Breadcrumb",ru="Навигационная цепочка",bn="অবস্থানের পথ",hi="पृष्ठ का रास्ता")[lang]}"><a href="{home(lang)}">{UI[lang]["guides"]}</a><span>/</span><a href="{category_path}">{e(category)}</a></nav><header class="article-heading"><p class="eyebrow">{e(category)}</p><h1>{e(a["title"])}</h1>{intro}<p class="byline">MetaStocker · <time datetime="{p["modified"]}">{p["modified"]}</time> · {max(3,math.ceil(len(words(a))/210))} {UI[lang]["minutes"]}</p></header>'
            html += '<figure><img class="diagram" src="'+img+'" width="1200" height="540" alt="'+e(a['illustration']['title']+': '+'; '.join(s['label']+' — '+s['detail'] for s in a['illustration']['steps']))+'"><figcaption>'+(UI[lang]["diagram"])+'</figcaption></figure>'
            html += '<nav class="toc" aria-label="'+(UI[lang]["toc"])+'"><strong>'+(UI[lang]["toc"])+'</strong><ol>'+''.join(f'<li><a href="#step-{i}">{e(re.sub(r'^\d+[.)]\s*', '', s['heading']))}</a></li>' for i,s in enumerate(a['sections'],1))+'</ol></nav><div class="prose">'
            for i,s in enumerate(a['sections'],1):
                html += f'<section id="step-{i}"><h2>{e(s["heading"])}</h2>'+''.join('<p>'+e(t)+'</p>' for t in s['paragraphs'])
                if s['bullets']: html += '<ul>'+''.join('<li>'+e(t)+'</li>' for t in s['bullets'])+'</ul>'
                if s['example']: html += '<pre class="example">'+e(s['example'])+'</pre>'
                html += '</section>'
            html += '<section class="checklist"><h2>'+(UI[lang]["checklist"])+'</h2><ul>'+''.join('<li>'+e(t)+'</li>' for t in a['checklist'])+'</ul></section></div>'+cta(lang)
            html += '<section class="sources"><h2>'+(UI[lang]["sources"])+'</h2><p>'+(UI[lang]["disclosure"])+f' <a href="{home(lang)}editorial.html">'+(UI[lang]["editorial"])+'</a>.</p><ul>'+''.join(f'<li><a href="{e(sources[s]["url"])}" rel="noopener">{e(sources[s]["title"])}</a></li>' for s in p['source_ids'])+'</ul></section>'
            related = [q for q in posts if q['slug']!=p['slug'] and q['category']==p['category']][:3]
            html += '<section class="related"><h2>'+(UI[lang]["related"])+'</h2><ul>'+''.join(f'<li><a href="{path_for(q["slug"],lang)}">{e(q[lang]["title"])}</a></li>' for q in related)+'</ul></section></main>'+footer(lang)
            write(public,path,html)
            entries.append(dict(path=path,modified=p['modified'],alternates=alternates))
    for lang in LANGUAGES:
        index_title = UI[lang]["index_title"]
        index_description = UI[lang]["index_description"]
        for category in [None]+list(CATEGORIES):
            selected = [p for p in posts if not category or p['category']==category]
            if not selected: continue
            prefix = home(lang)+('topics/'+category+'/' if category else '')
            pages = math.ceil(len(selected)/12)
            for page in range(1,pages+1):
                path = prefix+('page/'+str(page)+'/' if page>1 else '')
                suffix = ('topics/'+category+'/' if category else '')+('page/'+str(page)+'/' if page>1 else '')
                alternates = language_paths(suffix)
                title = category_text(category, lang) if category else index_title
                if page>1: title += (" · "+UI[lang]["page"]+" ")+str(page)
                description = category_text(category, lang, True) if category else index_description
                cards = selected[(page-1)*12:page*12]
                data = {'@context':'https://schema.org','@type':'CollectionPage','name':title,'description':description,'url':BASE+path,'inLanguage':lang,'mainEntity':{'@type':'ItemList','itemListElement':[{'@type':'ListItem','position':i,'url':BASE+path_for(q['slug'],lang),'name':q[lang]['title']} for i,q in enumerate(cards,1)]}}
                html = head(title,description,path,lang,alternates,data)+navigation(lang,alternates)+f'<main id="main" class="wide listing"><header class="listing-heading"><p class="eyebrow">MetaStocker Journal</p><h1>{e(title)}</h1><p class="dek">{e(description)}</p><p class="count">{len(selected)} '+(UI[lang]["count"])+'</p></header>'
                html += '<nav class="categories" aria-label="'+(UI[lang]["topics"])+f'"><a href="{home(lang)}"'+(' aria-current="page"' if not category else '')+'>'+(UI[lang]["all_topics"])+'</a>'+''.join(f'<a href="{home(lang)}topics/{key}/"'+(' aria-current="page"' if key==category else '')+f'>{e(category_text(key,lang))}</a>' for key,value in CATEGORIES.items() if any(q['category']==key for q in posts))+'</nav><div class="cards">'
                for q in cards:
                    html += f'<article class="guide-card"><a href="{path_for(q["slug"],lang)}"><img src="/assets/guides/{q["slug"]}-{lang}.svg" width="1200" height="540" alt="" loading="lazy"><div class="card-copy"><p class="eyebrow">{e(category_text(q["category"],lang))}</p><h2>{e(q[lang]["title"])}</h2><p>{e(q[lang]["description"])}</p><span class="read">'+(UI[lang]["read"])+'</span></div></a></article>'
                html += '</div><nav class="pagination" aria-label="'+(UI[lang]["pages"])+'">'+''.join(f'<a href="{prefix+("page/"+str(i)+"/" if i>1 else "")}"'+(' aria-current="page"' if i==page else '')+f'>{i}</a>' for i in range(1,pages+1))+'</nav>'+cta(lang)+'</main>'+footer(lang)
                write(public,path,html); entries.append(dict(path=path,modified=max(p['modified'] for p in selected),alternates=alternates))
        path=home(lang)+'editorial.html'
        title=UI[lang]["editorial_title"]
        description=UI[lang]["editorial_description"]
        text=('Материалы MetaStocker помогают авторам готовить точные метаданные и понимать работу локального AI. Тексты создаются с помощью Codex по отдельным редакционным заданиям. Для требований платформ используются официальные источники, ссылки на которые приведены в каждой статье. Примеры придуманы для обучения и не описывают результаты клиентов. Схемы создаются из шагов конкретного руководства.\n\nПеред выпуском выполняются проверки структуры, четырёх языковых версий, ссылок, повторяющегося текста и технической корректности страниц. Автоматическая редакционная проверка может пропустить ошибку. Мы не называем её человеческой экспертизой и не гарантируем одобрение файлов, позиции в поиске или продажи. Перед отправкой работ сверяйтесь с актуальными требованиями стока.\n\nДата публикации относится к конкретному материалу; дата изменения обновляется только при изменении содержания. Английские, русские, бенгальские и хинди-версии имеют собственные адреса. Локальные модели генератора работают в браузере пользователя; серверная подготовка статей не меняет этот принцип. Сообщить об ошибке можно через Contact на главной странице.' if lang=='ru' else 'MetaStocker guides help contributors prepare accurate metadata and understand local AI. Drafts are created with Codex from distinct editorial assignments. Platform requirements are grounded in official references linked from each article. Worked examples are created for teaching and do not describe customer results. Illustrations are drawn from each guide’s concrete workflow.\n\nBefore publication, checks cover structure, all four languages, links, repeated text and page correctness. Automated editorial review can miss mistakes. We do not present it as human expertise or guarantee asset approval, search positions or sales. Check the current marketplace requirements before submitting work.\n\nPublication dates refer to the individual guide; modification dates change only when content changes. English, Russian, Bengali and Hindi versions have separate addresses. Generator models run in the visitor’s browser; server-side article writing does not change that. Report a correction through Contact on the home page.')
        alternates=language_paths('editorial.html')
        text=EDITORIAL_EXTRA.get(lang,text)
        html=head(title,description,path,lang,alternates,{'@context':'https://schema.org','@type':'AboutPage','name':title,'url':BASE+path})+navigation(lang,alternates)+'<main id="main" class="article prose"><h1>'+e(title)+'</h1>'+''.join('<p>'+e(s)+'</p>' for s in text.split('\n\n'))+cta(lang)+'</main>'+footer(lang)
        write(public,path,html);entries.append(dict(path=path,alternates=alternates))
    sitemap='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    for entry in entries:
        sitemap+='<url><loc>'+BASE+xml_escape(entry['path'])+'</loc>'
        if entry.get('modified'):sitemap+='<lastmod>'+entry['modified']+'</lastmod>'
        for lang,path in entry.get('alternates',{}).items():sitemap+=f'<xhtml:link rel="alternate" hreflang="{lang}" href="{BASE}{path}"/>'
        sitemap+='</url>\n'
    write(public,'/sitemap.xml',sitemap+'</urlset>\n')
    content_hash=hashlib.sha256(json.dumps(posts,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    return {'articles':len(posts)*len(LANGUAGES),'topics':len(posts),'content_hash':content_hash,'paths':[p['path'] for p in entries]}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,default=ROOT);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--extra',type=Path)
    args=parser.parse_args();print(json.dumps(build(args.source,args.output,args.extra),indent=2))
