#!/usr/bin/env python3
"""One four-language topic per Warsaw calendar day, with durable drafts and rollback."""
import argparse
from datetime import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
from zoneinfo import ZoneInfo
from build_blog import load_posts, load_topics, validate
from review_articles import review
from validate_site import check
from write_articles import write_one, ROOT
from translate_articles import translate,source_hash
from plan_topics import plan_more
from refresh_sources import refresh

BASE=Path('/opt/metastocker')
STATE=BASE/'editorial'
TZ=ZoneInfo('Europe/Warsaw')


def stamp():
    return datetime.now(TZ).isoformat(timespec='seconds')


def atomic(path, data, owner=None):
    temp=path.with_name('.'+path.name+'.tmp')
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    temp.chmod(0o600)
    if owner:os.chown(temp,*owner)
    temp.replace(path)


def status(data):
    atomic(STATE/'status.json',data)
    atomic(BASE/'data/editorial-status.json',data,(1001,1001))


def run(check_only=False, force=False):
    STATE.mkdir(exist_ok=True,mode=0o700)
    for name in ('published','drafts','reviews','logs','backups','translations'):
        (STATE/name).mkdir(exist_ok=True,mode=0o700)
    with (STATE/'run.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'status':'already_running'}
        try:
            previous=json.loads((STATE/'status.json').read_text()) if (STATE/'status.json').exists() else {}
            today=datetime.now(TZ).date().isoformat()
            current=json.loads((BASE/'current/public/release.json').read_text())
            posts,sources=load_posts(ROOT,STATE/'published')
            active_names={p.stem for p in (ROOT/'content/posts').glob('*.json') if p.name!='_topics.json'}
            durable_names={p.stem for p in (STATE/'published').glob('*.json') if p.name!='_topics.json'}
            pending=durable_names-active_names
            topics=load_topics(ROOT,STATE/'published')
            known={p['slug'] for p in posts}
            queue=[t for t in topics if t['slug'] not in known]
        except Exception as error:
            if not check_only:
                status({'status':'failed','failed_at':stamp(),'error':type(error).__name__})
            raise
        result={'status':'ready','checked_at':stamp(),'articles':current['editorial']['articles'],'topics':current['editorial']['topics'],'remaining_topics':len(queue),'schedule':'09:15 Europe/Warsaw','cadence':'1 topic / 4 language versions per day','last_success':previous.get('last_success'),'last_topic':previous.get('last_topic')}
        if check_only:
            check(BASE/'current/public')
            subprocess.run(['docker','exec','metastocker-editorial','/var/lib/vintage-inventory/codex/bin/codex','login','status'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            return dict(result,status='check_passed')
        # An activation may have succeeded while the external HTTPS check failed.
        # Recheck that release before generating another topic on a retry.
        recovered_topic=previous.get('current_topic') in (active_names & durable_names)
        if previous.get('status') in ('failed','publishing') and (previous.get('release')==current['release'] or recovered_topic) and not pending:
            subprocess.run(['python3',str(ROOT/'deploy/verify_production.py'),'--release',current['release'],'--commit',current['commit']],check=True,stdout=subprocess.DEVNULL,timeout=600)
            result.update(status='published',last_success=stamp(),last_topic=previous.get('current_topic') or previous.get('last_topic'),release=current['release'])
            status(result)
            return result
        if (previous.get('last_success') or '')[:10]==today and not force and not pending:
            return dict(result,status='already_published_today')
        try:
            if not pending:
                if not queue:
                    result['status']='planning';status(result)
                    topics=plan_more(STATE/'published',STATE/'logs')
                    queue=[t for t in topics if t['slug'] not in known]
                    if not queue:raise RuntimeError('topic_queue_empty')
                topic=queue[0];slug=topic['slug'];result.update(status='writing',current_topic=slug)
                status(result)
                schema=json.loads((ROOT/'seo/article.schema.json').read_text())
                draft=STATE/'drafts'/(slug+'.json')
                review_path=STATE/'reviews'/(slug+'.json')
                feedback=''
                fresh_sources=refresh(topic,sources,STATE/'logs')
                atomic(STATE/'reviews'/(slug+'-sources.json'),fresh_sources)
                for attempt in range(3):
                    if not draft.exists() or attempt:
                        write_one(topic,STATE/'drafts',feedback=feedback,fresh_sources=fresh_sources)
                    article=json.loads(draft.read_text())
                    try:
                        validate(article,sources,schema,topic)
                    except ValueError as error:
                        feedback=str(error);continue
                    result['status']='translating';status(result)
                    translation_path=STATE/'translations'/(slug+'.json')
                    translated=json.loads(translation_path.read_text()) if translation_path.exists() else {}
                    if translated.get('source_hash')!=source_hash(article) or attempt > 0:
                        translated=translate(article,translation_path,feedback=feedback)
                    article.update({lang:translated[lang] for lang in ('bn','hi')})
                    try:
                        validate(article,sources,schema,topic,complete=True)
                    except ValueError as error:
                        feedback=str(error);continue
                    result['status']='reviewing';status(result)
                    verdict=review([article],review_path,fresh_sources=fresh_sources)['articles'][0]
                    if verdict['approved'] and not verdict['issues']:
                        draft.write_text(json.dumps(article,ensure_ascii=False,indent=2)+'\n')
                        break
                    feedback='; '.join(verdict['issues'])
                else:
                    raise RuntimeError('editorial_review_failed')
                # Make approved content durable before publication. A failed release is retried,
                # never silently discarded by the next code deployment.
                backup=STATE/'backups'/('content-'+datetime.now(TZ).strftime('%Y%m%dT%H%M%S')+'.tar.gz')
                with tarfile.open(backup,'w:gz') as archive:
                    archive.add(STATE/'published',arcname='published')
                    if (STATE/'status.json').exists():archive.add(STATE/'status.json',arcname='status.json')
                shutil.copyfile(draft,STATE/'published'/draft.name)
                (STATE/'published'/draft.name).chmod(0o600)
                pending={slug}
            result.update(status='publishing',current_topic=sorted(pending)[0]);status(result)
            release=datetime.now(TZ).strftime('%Y%m%dT%H%M%S')+'-seo-'+current['commit'][:12]
            output=BASE/'releases'/release
            spec=importlib.util.spec_from_file_location('release_builder',ROOT/'deploy/build_release.py')
            builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
            metadata=builder.build(ROOT,output,release,current['commit'],STATE/'published')
            check(output/'public')
            result['release']=release;status(result)
            with (STATE/'logs'/(release+'.log')).open('w') as log:
                subprocess.run(['bash',str(output/'deploy/activate-release.sh'),release],check=True,stdout=log,stderr=log,timeout=600,env=dict(os.environ,METASTOCKER_EXPECTED_RELEASE=current['release']))
                subprocess.run(['python3',str(output/'deploy/verify_production.py'),'--release',release,'--commit',current['commit']],check=True,stdout=log,stderr=log,timeout=600)
            result.update(status='published',last_success=stamp(),last_topic=sorted(pending)[0],release=release,articles=metadata['editorial']['articles'],topics=metadata['editorial']['topics'],remaining_topics=len(load_topics(ROOT,STATE/'published'))-metadata['editorial']['topics'])
            result.pop('current_topic',None);status(result)
            return result
        except Exception as error:
            # Keep diagnostic logs private; UI gets a finite error code, not arbitrary text.
            result.update(status='failed',failed_at=stamp(),error=str(error) if str(error) in ('topic_queue_empty','editorial_review_failed') else type(error).__name__)
            status(result)
            raise


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');p.add_argument('--force',action='store_true');a=p.parse_args()
    print(json.dumps(run(a.check,a.force),ensure_ascii=False))
