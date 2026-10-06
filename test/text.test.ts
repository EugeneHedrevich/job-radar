import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, normalizeCompany, tokenSimilarity } from '../src/util/text.js';

describe('canonicalizeUrl', () => {
  it('strips tracking parameters, fragments and trailing slashes', () => {
    expect(canonicalizeUrl('https://www.linkedin.com/jobs/view/123/?trk=abc&utm_source=x#top')).toBe(
      'https://linkedin.com/jobs/view/123',
    );
  });

  it('treats http and https as the same listing', () => {
    expect(canonicalizeUrl('http://de.indeed.com/viewjob?jk=1')).toBe(canonicalizeUrl('https://de.indeed.com/viewjob?jk=1'));
  });

  it('keeps meaningful query parameters and sorts them', () => {
    expect(canonicalizeUrl('https://example.com/job?b=2&a=1')).toBe('https://example.com/job?a=1&b=2');
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
    expect(canonicalizeUrl(null)).toBe('');
  });
});

describe('normalizeCompany', () => {
  it('ignores legal suffixes and casing', () => {
    expect(normalizeCompany('Northwind Cloud Consulting GmbH')).toBe(normalizeCompany('northwind cloud consulting'));
  });

  it('keeps different companies distinct', () => {
    expect(normalizeCompany('Santander Consumer Bank Portugal')).not.toBe(normalizeCompany('Santander Consumer Finance'));
  });
});

describe('tokenSimilarity', () => {
  it('is 1 for identical text and 0 when one side is empty', () => {
    expect(tokenSimilarity('SAP BTP Developer', 'sap btp developer')).toBe(1);
    expect(tokenSimilarity('SAP BTP Developer', '')).toBe(0);
  });
});
