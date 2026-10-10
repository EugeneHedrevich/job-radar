import { describe, expect, it } from 'vitest';
import { normalizeJob, extractCountry } from '../src/normalize/index.js';

const minimal = {
  id: 'abc',
  title: 'SAP BTP Developer',
  job_url: 'https://www.linkedin.com/jobs/view/1?trk=x',
};

describe('normalizeJob', () => {
  it('keeps absent fields as null instead of inventing values', () => {
    const job = normalizeJob(minimal, 'linkedin')!;
    expect(job.company).toBeNull();
    expect(job.description).toBeNull();
    expect(job.descriptionHash).toBeNull();
    expect(job.isRemote).toBeNull();
    expect(job.jobType).toBeNull();
    expect(job.salaryMin).toBeNull();
    expect(job.salaryCurrency).toBeNull();
    expect(job.locationCountry).toBeNull();
  });

  it('never substitutes the collection time for the publication date', () => {
    const withoutDate = normalizeJob(minimal, 'linkedin')!;
    expect(withoutDate.datePosted).toBeNull();

    const withDate = normalizeJob({ ...minimal, date_posted: '2026-10-04' }, 'linkedin')!;
    expect(withDate.datePosted).toBe('2026-10-04');
  });

  it('marks a listing without a description as incomplete', () => {
    expect(normalizeJob(minimal, 'linkedin')!.listing.hasDescription).toBe(false);
    expect(normalizeJob({ ...minimal, description: 'text' }, 'linkedin')!.listing.hasDescription).toBe(true);
  });

  it('rejects records without a usable title or URL', () => {
    expect(normalizeJob({ ...minimal, title: null }, 'linkedin')).toBeNull();
    expect(normalizeJob({ ...minimal, job_url: null, job_url_direct: null }, 'linkedin')).toBeNull();
  });

  it('treats empty strings and unparseable values as unknown', () => {
    const job = normalizeJob(
      { ...minimal, company: '   ', min_amount: 'n/a', is_remote: '', date_posted: 'not a date' },
      'linkedin',
    )!;
    expect(job.company).toBeNull();
    expect(job.salaryMin).toBeNull();
    expect(job.isRemote).toBeNull();
    expect(job.datePosted).toBeNull();
  });

  it('produces a stable fingerprint for the same listing', () => {
    const first = normalizeJob(minimal, 'linkedin')!;
    const second = normalizeJob({ ...minimal, job_url: 'https://www.linkedin.com/jobs/view/1?utm_source=y' }, 'linkedin')!;
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});

describe('extractCountry', () => {
  it.each([
    ['Dubai, AE', 'United Arab Emirates'],
    ['Dubai, UAE', 'United Arab Emirates'],
    ['Dubai, U.A.E.', 'United Arab Emirates'],
    ['Abu Dhabi, United Arab Emirates', 'United Arab Emirates'],
    ['Johannesburg, ZA', 'South Africa'],
    ['Cairo, EG', 'Egypt'],
    ['Riyadh, SA', 'Saudi Arabia'],
    ['Doha, QA', 'Qatar'],
    ['Tel Aviv, IL', 'Israel'],
    ['Amman, Jordan', 'Jordan'],
    ['Istanbul, TR', 'Turkey'],
    ['Lagos, Nigeria', 'Nigeria'],
    ['Nairobi, KE', 'Kenya'],
    ['Tunis, TN', 'Tunisia'],
    ['Belgrade, RS', 'Serbia'],
  ])('recognises actual Middle Eastern and African locations: %s', (location, country) => {
    expect(extractCountry(location)).toBe(country);
  });

  it.each(['EMEA', 'Europe', 'Middle East', 'Africa', 'Dubai'])('does not invent a country for %s', (location) => {
    expect(extractCountry(location)).toBeNull();
  });

  it('resolves country codes and names, and gives up when unclear', () => {
    expect(extractCountry('Berlin, Berlin, DE')).toBe('Germany');
    expect(extractCountry('Amsterdam, North Holland, Netherlands')).toBe('Netherlands');
    expect(extractCountry('Remote')).toBeNull();
    expect(extractCountry(null)).toBeNull();
  });
});
