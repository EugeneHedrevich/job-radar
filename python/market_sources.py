"""Public contract boards: request building and parsing only.

Collection, accounting, relevance, persistence and assessment stay in the existing
public-source pipeline. No guessed/private APIs, logins or anti-bot workarounds.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlparse

from markdownify import markdownify
from activity import observe, page_closure
from sap_sources import applicant_location, job_posting, page_soup, text

MARKET_SOURCES = {
    'freelancermap': ('https://www.freelancermap.com', 'freelancermap'),
    'jobserve': ('https://www.jobserve.com', 'JobServe'),
    'freelancede': ('https://www.freelance.de', 'freelance.de'),
    'hays': ('https://www.hays.de', 'Hays'),
    'justjoin': ('https://justjoin.it', 'Just Join IT'),
    'nofluffjobs': ('https://nofluffjobs.com', 'No Fluff Jobs'),
}


def search_url(source, keyword, market, page):
    root = MARKET_SOURCES[source][0]
    if source == 'hays':
        return root + '/jobsuche/stellenangebote-jobs?' + urlencode({'q': keyword, 'page': page})
    if source == 'justjoin':
        return root + '/job-offers/all-locations?' + urlencode({'keyword': keyword, 'page': page})
    if source == 'freelancede':
        if page > 1:
            raise ValueError('freelance.de continuation must use its published search link')
        return root + '/' + quote(keyword, safe='') + '-Projekte'
    if source == 'freelancermap':
        return root + '/project-search?' + urlencode({'query': keyword, 'sort': 1, 'pagenr': page})
    if source == 'nofluffjobs':
        return root + '/pl/' + quote(keyword.lower(), safe='') + (f'?page={page}' if page > 1 else '')
    # JobServe's saved RSS searches require an account. Inspect the public form;
    # never accept its unfiltered home/recommendation cards as keyword results.
    return root + '/gb/en/Job-Search/'


def date_value(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if re.match(r'^\d{4}-\d{2}-\d{2}', value):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return value if parsed.tzinfo else value[:10]
        except ValueError:
            return None
    offset = 2 if re.search(r'\bCEST\b', value) else 1 if re.search(r'\bCET\b', value) else None
    value = re.sub(r'\s+(?:CEST|CET)\b', '', value)
    for fmt in ('%d.%m.%Y %H:%M', '%d.%m.%Y', '%a %b %d %H:%M:%S %Y', '%d/%m/%Y %H:%M:%S'):
        try:
            parsed = datetime.strptime(value, fmt)
            return parsed.replace(tzinfo=timezone(timedelta(hours=offset))).isoformat() if offset is not None else parsed.date().isoformat()
        except ValueError:
            pass
    return None


def embedded_objects(soup):
    """Read JSON/Next Flight JSON values without evaluating JavaScript."""
    def walk(value):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk(child)
    for script in soup.select('script'):
        raw = script.get_text().strip().removesuffix(';')
        if script.get('type') == 'application/ld+json' or script.get('id') in {'__NEXT_DATA__', 'ng-state'}:
            try:
                yield from walk(json.loads(raw))
            except (ValueError, TypeError):
                pass
        elif raw.startswith('self.__next_f.push('):
            try:
                payload = json.loads(raw[len('self.__next_f.push('):-1])
            except ValueError:
                continue
            if len(payload) > 1 and isinstance(payload[1], str):
                # Large RSC text frames can run straight into the next record;
                # decode the named JSON values as well as newline-delimited records.
                for match in re.finditer(r'"(?:offer|offers)":\s*', payload[1]):
                    try:
                        value, _ = json.JSONDecoder().raw_decode(payload[1], match.end())
                        yield from walk({'offers': value} if isinstance(value, list) else value)
                    except ValueError:
                        pass
                for line in payload[1].splitlines():
                    try:
                        yield from walk(json.loads(line.split(':', 1)[1]))
                    except (ValueError, IndexError):
                        pass


def engagement(value):
    value = (value or '').lower()
    if 'arbeitnehmerüberlassung' in value or 'leasing' in value or 'agency contract' in value:
        return 'employee_leasing'
    if 'freiberuflich/in temporärer' in value:
        return None  # Provider offers alternatives; neither is confirmed exclusively.
    if any(token in value for token in ('b2b', 'freiberuflich', 'freelance', 'contracting', 'contractor')) or value == 'contract':
        return 'contract'
    if any(token in value for token in ('festanstellung', 'permanent', 'employment', 'uop', 'umowa o pracę')):
        return 'fulltime'
    return None


def identifier(source, url, posting=None):
    posting = posting or {}
    stated = posting.get('identifier')
    if isinstance(stated, dict):
        stated = stated.get('value')
    if isinstance(stated, (str, int)) and str(stated).strip():
        return str(stated)
    path = urlparse(url).path.rstrip('/')
    patterns = {'freelancede': r'/projekt-(\d+)', 'hays': r'-(\d+/\d+)$',
                'freelancermap': r'-(\d+)$', 'jobserve': r'/job/([a-f0-9]+)'}
    match = re.search(patterns.get(source, r'(?!)'), path, re.I)
    query = parse_qs(urlparse(url).query)
    return match[1] if match else query.get('prospectNr', query.get('prospectId', query.get('jid', [None])))[0] or path.rsplit('/', 1)[-1]


def pay_terms(row, terms):
    """Keep every original offer; choose B2B for the existing scalar pay fields."""
    from public_sources import number
    original = [term for term in terms if isinstance(term, dict) and term.get('currencySource') != 'conversion']
    row.setdefault('source_facts', {})['employment_terms'] = original
    term = next((term for term in original if term.get('type') == 'b2b'), next(iter(original), {}))
    row['job_type'] = engagement(term.get('type'))
    unit = {'hour': 'hourly', 'day': 'daily', 'month': 'monthly', 'year': 'yearly'}.get(term.get('unit'))
    if unit and term.get('currency'):
        row.update(min_amount=number(term.get('fromPerUnit', term.get('from'))),
                   max_amount=number(term.get('toPerUnit', term.get('to'))), currency=term['currency'], interval=unit)
    basis = 'gross' if term.get('gross') is True else 'net' if term.get('gross') is False else None
    row['source_facts']['salary_basis'] = basis
    return term


def skill_names(values):
    return [value if isinstance(value, str) else value['name'] for value in values
            if isinstance(value, str) or isinstance(value, dict) and isinstance(value.get('name'), str)]


def polish_card_pay(row, value):
    # No Fluff Jobs' public cards state B2B/UoP, currency and the original unit.
    # Its public salary legend states net + VAT for B2B and gross for UoP.
    match = re.search(r'\b(B2B|UoP)\s+([\d\s\u00a0.,]+?)\s*[–-]\s*([\d\s\u00a0.,]+?)\s+(PLN|EUR|USD|GBP)\s*/\s*(godz\.?|h\b|dzień|mies\.?|rok)', value or '', re.I)
    if not match:
        return
    from public_sources import number
    low, high = [number(re.sub(r'[\s\u00a0]', '', raw).replace(',', '.')) for raw in (match[2], match[3])]
    if low is None or high is None:
        return
    contract = match[1].lower() == 'b2b'
    unit = match[5].lower().rstrip('.')
    row.update(job_type='contract' if contract else 'fulltime', min_amount=low, max_amount=high,
               currency=match[4].upper(), interval={'godz': 'hourly', 'h': 'hourly', 'dzień': 'daily', 'mies': 'monthly', 'rok': 'yearly'}[unit])
    row.setdefault('source_facts', {}).update(salary_basis='net' if contract else 'gross',
        salary_legend='No Fluff Jobs: net + VAT for B2B; gross for UoP',
        employment_terms=[{'type': match[1], 'from': low, 'to': high, 'currency': row['currency'],
                           'unit': row['interval'], 'gross': not contract}])


def join_row(record):
    from public_sources import safe_public_url
    url = safe_public_url('justjoin', '/job-offer/' + record['slug'])
    places = record.get('multilocation') or [{'city': record.get('city'), 'street': record.get('street')}]
    workplace = record.get('workplaceType')
    workplace = workplace.get('value') if isinstance(workplace, dict) else workplace
    row = {'site': 'justjoin', 'id': record.get('guid') or record['slug'], 'job_url': url,
           'title': record.get('title'), 'company': record.get('companyName'),
           'location': '; '.join(dict.fromkeys(place['city'] for place in places if place.get('city'))) or None,
           'date_posted': date_value(record.get('publishedAt')), 'description': None,
           'is_remote': True if workplace == 'remote' else False if workplace == 'office' else None,
           'source_facts': {key: record.get(key) for key in ('workplaceType', 'publishedAt', 'lastPublishedAt', 'expiredAt', 'multilocation', 'requiredSkills', 'niceToHaveSkills')}}
    pay_terms(row, record.get('employmentTypes') or [])
    return row


def more_pages(soup, page):
    for link in soup.select('a[href]'):
        query = parse_qs(urlparse(link['href']).query)
        if ('next' in link.get('rel', []) or text(link) in {'Next', 'Weiter', 'Następna'} or
            query.get('page') == [str(page + 1)] or query.get('pagenr') == [str(page + 1)] or
            query.get('_offset') == [str(page * 20)]):
            return True
    return False


def parse_search(source, html, root, page=1):
    from public_sources import safe_public_url
    soup = page_soup(html)
    rows = []
    if source == 'justjoin':
        objects = list(embedded_objects(soup))
        offers = next((item['offers'] for item in objects if isinstance(item.get('offers'), list)), None)
        if offers is None:
            raise ValueError('Just Join IT search has no recognized public offer data')
        rows = [join_row(record) for record in offers if record.get('slug') and record.get('title')]
    elif source == 'hays':
        for card in soup.select('.search__result'):
            link = card.select_one('a.search__result__link[href]')
            if not link:
                raise ValueError('Hays result has no original vacancy URL')
            url = safe_public_url(source, link['href'])
            contract = text(card.select_one('.search__result__job__attribute__type .info-text'))
            posted = re.search(r'Online (?:seit|since):\s*(.*?)(?:$|\n)', card.get_text('\n', strip=True))
            rows.append({'site': source, 'id': identifier(source, url), 'job_url': url,
                         'title': text(card.select_one('h4')), 'company': None, 'description': None,
                         'location': text(card.select_one('.search__result__job__attribute__location .info-text')),
                         'job_type': engagement(contract), 'date_posted': date_value(posted[1]) if posted else None,
                         'source_facts': {'engagement': contract, 'project_reference': identifier(source, url),
                                          'published': posted[1] if posted else None}})
        count = soup.select_one('#totalJobs')
        count_text = text(count) or ''
        if not rows and not re.search(r'\d', count_text):
            raise ValueError('Hays search markup is unrecognized')
        if not re.search(r'\d', count_text):
            return rows, None
        total = int(re.sub(r'\D', '', count_text))
        return rows, page * 20 < total
    elif source == 'freelancede':
        active = soup.select_one('.pagination .active')
        if page > 1 and (not active or text(active) != str(page)):
            raise ValueError('freelance.de did not honour anonymous pagination; unable to verify continuation, saved cursor retained')
        for card in soup.select('.list-item-main'):
            link = card.select_one('h3 a[href*="/projekte/projekt-"]')
            if not link:
                raise ValueError('freelance.de result has no title or original URL')
            url = safe_public_url(source, link['href'])
            dates = re.findall(r'\b\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\b', card.get_text(' ', strip=True))
            row = {'site': source, 'id': identifier(source, url), 'job_url': url, 'title': text(link),
                   'description': None, 'company': None, 'date_posted': date_value(dates[-1]) if dates else None,
                   'source_facts': {'card_metadata': text(card.select_one('.overview')), 'company_visibility': 'not publicly stated'}}
            locations = [text(li) for li in card.select('.overview li') if li.select_one('.fa-map-marker-alt, .fa-map-marker')]
            row['location'] = ', '.join(filter(None, locations)) or None
            rows.append(row)
        if not rows and not re.search(r'keine projekte|\b0\s+Projekte\b', soup.get_text(' ', strip=True), re.I):
            raise ValueError('freelance.de returned an unexpected page, not an empty search')
    else:
        # Public structured/linked cards only. A block or changed format is an
        # explicit failure, never a fabricated empty successful search.
        pattern = '/project/' if source == 'freelancermap' else '/job/'
        seen = set()
        for link in soup.select('a[href]'):
            if pattern not in link['href'] or not text(link):
                continue
            url = safe_public_url(source, link['href'])
            if url in seen:
                continue
            seen.add(url)
            heading = link.select_one('h2, h3, [itemprop="title"]')
            row = {'site': source, 'id': identifier(source, url), 'job_url': url,
                         'title': text(heading) or text(link), 'description': None, 'company': None,
                         'source_facts': {'card_metadata': text(link)}}
            if source == 'nofluffjobs':
                polish_card_pay(row, text(link))
            rows.append(row)
        if not rows:
            raise ValueError(f'{source} public result markup unavailable; coverage not verified')
    more = more_pages(soup, page)
    return rows, more if source in {'justjoin', 'freelancede'} or more else None


def jobserve_form(html, keyword):
    """Follow the public form's actual action/field names, not an invented API."""
    from public_sources import safe_public_url
    soup = page_soup(html)
    for form in soup.select('form'):
        fields = {node['name']: node.get('value', '') for node in form.select('input[name]')
                  if node.get('type', '').lower() in {'hidden', 'text', 'search', ''}}
        keys = [node['name'] for node in form.select('input[name]')
                if re.search(r'(?:keywords?|txtkey)$', node.get('name', ''), re.I)]
        if len(keys) != 1:
            continue
        fields[keys[0]] = keyword
        for control in form.select('select[name]'):
            selected = control.select_one('option[selected]') or control.select_one('option')
            if selected:
                fields[control['name']] = selected.get('value', '')
        submit = form.select_one('input[type="submit"][name], button[type="submit"][name]')
        if submit:
            fields[submit['name']] = submit.get('value', '')
        return safe_public_url('jobserve', form.get('action') or search_url('jobserve', keyword, None, 1)), form.get('method', 'get').lower(), fields
    raise RuntimeError('blocked: JobServe returned no usable public search form; unable to verify collection')


def hydrate(source, row, html, description_format):
    from public_sources import apply_posting
    soup = page_soup(html)
    posting = job_posting(soup) or {}
    closure = page_closure(row, soup, posting)
    if closure:
        return closure
    updated = {**row, 'source_facts': dict(row.get('source_facts') or {})}
    updated['id'] = row.get('id') or identifier(source, row['job_url'], posting)
    updated['title'] = row.get('title') or posting.get('title') or text(soup.select_one('h1'))
    apply_posting(updated, posting)
    updated['date_posted'] = date_value(posting.get('datePosted')) or row.get('date_posted')
    types = posting.get('employmentType') or []
    types = types if isinstance(types, list) else [types]
    stated = {engagement(value) for value in types} - {None}
    if len(stated) == 1:
        updated['job_type'] = next(iter(stated))
    employer = posting.get('hiringOrganization')
    updated['company'] = row.get('company') or (employer.get('name') if isinstance(employer, dict) else None)
    updated['source_facts'].update({key: posting[key] for key in ('identifier', 'datePosted', 'hiringOrganization', 'employmentType', 'jobLocation', 'jobLocationType', 'applicantLocationRequirements', 'baseSalary', 'qualifications', 'skills') if key in posting})
    description = posting.get('description')
    if source == 'hays':
        node = soup.select_one('#hays__job__full__detail')
        if node:
            # The DOM preserves section/list boundaries missing from Hays JSON-LD.
            description = str(node)
            contract_node = node.select_one('.file-icon + .info-text')
            contract = text(contract_node) or updated['source_facts'].get('engagement')
            updated['job_type'] = engagement(contract)
            reference = text(node.select_one('.h-job-detail__meta-item__reference')) or ''
            match = re.search(r'\b\d+/\d+\b', reference)
            reference = match[0] if match else identifier(source, row['job_url'], posting)
            updated['id'] = reference
            updated['source_facts'].update(engagement=contract, project_reference=reference)
    if source == 'justjoin':
        slug = urlparse(row['job_url']).path.rstrip('/').rsplit('/', 1)[-1]
        record = next((item for item in embedded_objects(soup) if item.get('slug') == slug and item.get('title') and isinstance(item.get('employmentTypes'), list)), None)
        if record:
            parsed = join_row(record)
            updated['source_facts'].update(parsed.pop('source_facts'))
            updated.update({key: value for key, value in parsed.items() if value is not None})
            apply_posting(updated, posting)
            updated['date_posted'] = date_value(posting.get('datePosted')) or parsed.get('date_posted')
            pay_terms(updated, record['employmentTypes'])
            if record.get('workplaceType'):
                updated['is_remote'] = parsed['is_remote']
            body = record.get('body')
            description = body if isinstance(body, str) and body != record.get('title') and not body.startswith('$') else posting.get('description')
        if not posting and (not record or record.get('body') == record.get('title')):
            description = None
    if source == 'freelancede' and soup.select_one('.panel-body .teaser'):
        updated['source_facts'].update(description_status='partial_requires_account', description_excerpt=description)
        updated['company'] = row.get('company')  # Public teaser hides the employer; platform name is not evidence.
        updated['description'] = None
        return updated  # A teaser is not a complete, verifiable vacancy description.
    if source == 'nofluffjobs' and (row.get('source_facts') or {}).get('employment_terms'):
        # Coarse JobPosting FULL_TIME must not overwrite the card's explicit B2B
        # contract or its original hourly/daily amounts with a monthly display.
        updated.update({key: row[key] for key in ('job_type', 'min_amount', 'max_amount', 'currency', 'interval') if key in row})
    if not isinstance(description, str) or not description.strip():
        raise ValueError(f'{source} public detail has no verifiable description; unable to verify')
    description = markdownify(description).strip() if description_format == 'markdown' else description
    required_location = applicant_location(posting)
    if required_location:
        description = f'Candidate required location: {required_location}\n\n' + description
    facts = updated['source_facts']
    prefix = []
    if facts.get('engagement'):
        prefix.append('Engagement: ' + facts['engagement'])
    if facts.get('project_reference'):
        prefix.append('Project reference: ' + facts['project_reference'])
    if facts.get('salary_basis'):
        prefix.append('Salary basis: ' + facts['salary_basis'])
    if facts.get('requiredSkills'):
        prefix.append('Required skills: ' + ', '.join(skill_names(facts['requiredSkills'])))
    if facts.get('niceToHaveSkills'):
        prefix.append('Preferred skills: ' + ', '.join(skill_names(facts['niceToHaveSkills'])))
    updated['description'] = '\n'.join(prefix) + '\n\n' + description
    return observe(updated, 'active', 'Public vacancy contains a description', valid_through=posting.get('validThrough'))
