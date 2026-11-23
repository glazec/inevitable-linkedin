"""Enrich extension CSVs using Lima. Preview by default; --run makes paid requests."""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, unquote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

ENDPOINT = 'https://api.limadata.com/api/v2/batch/people'
RESULTS = 'https://api.limadata.com/api/v2/batch/results?batch_id='
PENDING = {'processing', 'pending', 'queued', 'in_progress'}
EXTRA = ['lima_company', 'lima_title', 'lima_headline', 'lima_checked_at',
         'employment_history', 'lima_education', 'enrichment_status', 'missing_fields', 'review_notes']
REQUIRED = ['name', 'current_company', 'titles', 'past_companies',
            'earliest_listed_full_time_start', 'connection_date', 'education', 'location']


def identity(url):
    p = urlsplit(url)
    parts = p.path.strip('/').split('/')
    if p.scheme not in ('http', 'https') or p.hostname not in ('linkedin.com', 'www.linkedin.com') or len(parts) != 2 or parts[0] != 'in':
        return ''
    return unquote(parts[1]).casefold()


def valid_date(value):
    try:
        datetime.strptime(value, '%Y-%m-%d')
        return True
    except (ValueError, TypeError):
        return False


def merge(row, response, checked_at):
    out = dict(row)
    p = response
    if not isinstance(p, dict) or not isinstance(p.get('experiences'), list) or not isinstance(p.get('educations'), list):
        raise ValueError('Unsupported Lima full profile response')
    if not identity(row.get('linkedin_url', '')) or identity(p.get('profile_url', '')) != identity(row['linkedin_url']):
        raise ValueError('Lima profile identity does not match input')
    jobs = p['experiences']
    current = [j for j in jobs if not j.get('ends_at')]
    past = list(dict.fromkeys(j['company'] for j in jobs if j.get('ends_at') and j.get('company')))
    full_time = sorted(j['starts_at'][:7] for j in jobs
                       if str(j.get('employment_type', '')).casefold() == 'full-time'
                       and valid_date(j.get('starts_at', '')))
    companies = list(dict.fromkeys(j['company'] for j in current if j.get('company')))
    titles = list(dict.fromkeys(j['title'] for j in current if j.get('title')))
    education = [{k: e[k] for k in ('school', 'degree', 'field_of_study', 'starts_at', 'ends_at') if e.get(k)} for e in p['educations']]
    location = p.get('location') or {}
    encode = lambda value: json.dumps(value, ensure_ascii=False)
    out.update(lima_company='; '.join(companies), lima_title='; '.join(titles),
               lima_headline=p.get('headline', ''), lima_checked_at=checked_at,
               lima_education=encode(education), employment_history=encode([
                   {k: j[k] for k in ('company', 'title', 'starts_at', 'ends_at', 'employment_type') if j.get(k)} for j in jobs]))
    candidates = {'name': p.get('full_name', ''), 'current_company': out['lima_company'],
                  'titles': encode(titles) if titles else '', 'past_companies': encode(past) if past else '',
                  'earliest_listed_full_time_start': full_time[0] if full_time else '',
                  'education': encode(education) if education else '',
                  'location': ', '.join(str(location[k]) for k in ('city', 'state', 'country') if location.get(k))}
    for k, value in candidates.items():
        if not out.get(k):
            out[k] = value
    out['missing_fields'] = encode([k for k in REQUIRED if not out.get(k)])
    out['enrichment_status'] = 'enriched_needs_review'
    out['review_notes'] = 'Current roles have no listed end date; compare headline for stale data. Career start is earliest listed full time role, not verified first job. Existing values preserved.'
    return out


def write_csv(path, fields, rows):
    def safe(v):
        s = str(v or '')
        return "'" + s if s.lstrip().startswith(('=', '+', '-', '@')) or s.startswith(('\t', '\r', '\n')) else s
    buffer = io.StringIO(newline='')
    writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction='ignore')
    writer.writeheader()
    writer.writerows({k: safe(v) for k, v in r.items()} for r in rows)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(buffer.getvalue(), encoding='utf-8-sig')
    temp.replace(path)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input', type=Path)
    ap.add_argument('output', type=Path)
    ap.add_argument('--run', action='store_true', help='Authorize paid Lima requests')
    ap.add_argument('--limit', type=int, default=1, help='Maximum paid requests this run')
    ap.add_argument('--wait-seconds', type=int, default=45, help='Maximum polling time per profile per run')
    ap.add_argument('--cache', type=Path, default=Path('artifacts/lima-profile-cache'))
    args = ap.parse_args()
    if args.input.resolve() == args.output.resolve():
        ap.error('Output must differ from input')
    if not 0 <= args.wait_seconds <= 300:
        ap.error('Wait seconds must be between 0 and 300')
    if args.limit < 1:
        ap.error('Limit must be positive')
    with args.input.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    if 'linkedin_url' not in fields:
        ap.error('Use the extension Export connections CSV button first')
    fields = list(dict.fromkeys(fields + REQUIRED + EXTRA))
    key = os.environ.get('LIMA_ENRICH_API_KEY') or os.environ.get('LIMA_API_KEY')
    if args.run and not key:
        ap.error('Set LIMA_API_KEY or LIMA_ENRICH_API_KEY in the environment')
    args.cache.mkdir(parents=True, exist_ok=True)
    requests = 0
    opener = build_opener(NoRedirect())
    for i, row in enumerate(rows):
        slug = identity(row.get('linkedin_url', ''))
        cache = args.cache / (hashlib.sha256(slug.encode()).hexdigest() + '.json')
        if not slug:
            row['enrichment_status'] = 'invalid_profile_url'
            continue
        try:
            if cache.exists():
                saved = json.loads(cache.read_text())
            elif args.run and (cache.with_suffix('.job.json').exists() or requests < args.limit):
                job_path = cache.with_suffix('.job.json')
                headers = {'x-api-key': key, 'Content-Type': 'application/json',
                           'Accept': 'application/json', 'User-Agent': 'inevitable-connections/0.2'}
                if job_path.exists():
                    job = json.loads(job_path.read_text())
                    if not isinstance(job.get('batch_id'), int):
                        raise ValueError('Previous submission outcome uncertain; reconcile in Lima before retrying')
                else:
                    requests += 1
                    job_path.write_text(json.dumps({'status': 'submission_uncertain', 'url': row['linkedin_url']}))
                    req = Request(ENDPOINT, data=json.dumps({'urls': [row['linkedin_url']]}).encode(), headers=headers)
                    with opener.open(req, timeout=45) as response:
                        job = json.load(response)
                    job_path.write_text(json.dumps(job))
                if not isinstance(job.get('batch_id'), int):
                    raise ValueError('Lima submission missing batch ID')
                # Resume saved jobs instead of submitting a second paid request.
                deadline = time.monotonic() + args.wait_seconds
                while True:
                    with opener.open(Request(RESULTS + str(job['batch_id']), headers={k: v for k, v in headers.items() if k != 'Content-Type'}), timeout=45) as response:
                        result = json.load(response)
                    if str(result.get('status', '')).casefold() not in PENDING or time.monotonic() >= deadline:
                        break
                    time.sleep(min(3, max(0, deadline - time.monotonic())))
                if str(result.get('status', '')).casefold() in PENDING:
                    row['enrichment_status'] = 'processing'
                    write_csv(args.output, fields, rows)
                    time.sleep(1)
                    continue
                items = result.get('items') or []
                if len(items) != 1 or identity(items[0].get('request', '')) != slug:
                    raise ValueError('Lima result does not match submitted profile')
                if str(items[0].get('status', '')).casefold() != 'completed':
                    row['enrichment_status'] = 'provider_failed'
                    write_csv(args.output, fields, rows)
                    continue
                saved = {'response': items[0]['data'], 'checked_at': datetime.now(timezone.utc).isoformat()}
                merge(row, saved['response'], saved['checked_at'])
                temp = cache.with_suffix('.tmp')
                temp.write_text(json.dumps(saved, ensure_ascii=False))
                temp.replace(cache)
                time.sleep(1)
            else:
                row['enrichment_status'] = 'pending'
                continue
            rows[i] = merge(row, saved['response'], saved['checked_at'])
        except HTTPError as error:
            row['enrichment_status'] = 'not_found' if error.code == 404 else f'http_{error.code}'
            if error.code != 404:
                write_csv(args.output, fields, rows)
                raise SystemExit(f'Stopped on HTTP {error.code}. CSV progress saved; no automatic retries.')
        except (ValueError, OSError) as error:
            row['enrichment_status'] = 'error_needs_review'
            write_csv(args.output, fields, rows)
            raise SystemExit(f'Stopped at row {i + 1}: {type(error).__name__}. CSV progress saved.')
        write_csv(args.output, fields, rows)
    write_csv(args.output, fields, rows)
    print(f'Wrote {len(rows)} rows; {requests} paid requests. Missing fields remain blank.')


if __name__ == '__main__':
    main()
