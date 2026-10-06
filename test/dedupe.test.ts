import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTempDb, useTempDb } from './helpers/db.js';
import { cds, db, SELECT, INSERT, query } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import { ingestJobs } from '../src/persist/ingest.js';

const DESCRIPTION =
  'We are looking for a freelance Senior SAP BTP Developer. You will build CAP services with Node.js and TypeScript, expose OData V4 and deploy to Cloud Foundry with XSUAA. Fully remote within the EU.';

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'li-1',
    title: 'Senior SAP BTP Developer',
    company: 'Northwind Cloud Consulting GmbH',
    location: 'Remote, Germany, DE',
    job_url: 'https://www.linkedin.com/jobs/view/111?trk=search',
    date_posted: '2026-10-04',
    description: DESCRIPTION,
    ...overrides,
  };
}

async function ingest(records: Array<{ source: string; data: Record<string, unknown> }>) {
  const normalized = records
    .map((entry) => normalizeJob(entry.data as any, entry.source))
    .filter((job): job is NonNullable<typeof job> => job !== null);
  return ingestJobs(normalized, { runId: null });
}

describe('deduplication', () => {
  beforeAll(async () => {
    await useTempDb();
  });
  afterAll(closeTempDb);

  it('creates one job per distinct listing', async () => {
    const result = await ingest([{ source: 'linkedin', data: record() }]);
    expect(result.created).toBe(1);
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(1);
  });

  it('does not create duplicates when the same collection runs again', async () => {
    const result = await ingest([{ source: 'linkedin', data: record() }]);
    expect(result.created).toBe(0);
    expect(result.mergedAcrossSources).toBe(0);
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(1);
    expect(await query(SELECT.from(db().SourceListings))).toHaveLength(1);
  });

  it('matches the same listing again even when its URL carries new tracking parameters', async () => {
    const result = await ingest([
      { source: 'linkedin', data: record({ id: null, job_url: 'https://www.linkedin.com/jobs/view/111?trk=other&utm_source=z' }) },
    ]);
    expect(result.created).toBe(0);
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(1);
  });

  it('merges the same vacancy found on another source into one job', async () => {
    const result = await ingest([
      {
        source: 'indeed',
        data: record({
          id: 'in-1',
          company: 'Northwind Cloud Consulting',
          job_url: 'https://de.indeed.com/viewjob?jk=111',
        }),
      },
    ]);
    expect(result.mergedAcrossSources).toBe(1);
    expect(result.created).toBe(0);
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(1);
    expect(await query(SELECT.from(db().SourceListings))).toHaveLength(2);
  });

  it('does not merge different companies that share a title', async () => {
    const result = await ingest([
      {
        source: 'indeed',
        data: record({ id: 'in-2', company: 'Contoso Industrie AG', job_url: 'https://de.indeed.com/viewjob?jk=222' }),
      },
    ]);
    expect(result.created).toBe(1);
    expect(result.mergedAcrossSources).toBe(0);
  });

  it('does not merge unrelated roles at the same company that merely share words in the title', async () => {
    const result = await ingest([
      {
        source: 'indeed',
        data: record({
          id: 'in-3',
          title: 'Senior SAP BTP Developer',
          job_url: 'https://de.indeed.com/viewjob?jk=333',
          description:
            'Permanent in-house position in our logistics department. You will maintain ABAP reports for warehouse processes and support key users on site in Hamburg five days per week.',
        }),
      },
    ]);
    expect(result.created).toBe(1);
    expect(result.mergedAcrossSources).toBe(0);
  });

  it('fills in a field that was unknown before without overwriting known values', async () => {
    const sparse = await ingest([
      {
        source: 'glassdoor',
        data: {
          id: 'gd-1',
          title: 'SAP Fiori Developer',
          company: 'Adventure Works Digital',
          job_url: 'https://www.glassdoor.com/job-listing/1',
          location: 'Sofia, BG',
          description: null,
          date_posted: null,
        },
      },
    ]);
    expect(sparse.created).toBe(1);

    const before = (await query<any>(SELECT.from(db().Jobs).where({ fingerprint: { '!=': '' }, company: 'Adventure Works Digital' })))[0];
    expect(before.description).toBeNull();
    expect(before.datePosted).toBeNull();
    const originalFirstSeen = before.firstSeenAt;

    await ingest([
      {
        source: 'glassdoor',
        data: {
          id: 'gd-1',
          title: 'SAP Fiori Developer',
          company: 'Adventure Works Digital',
          job_url: 'https://www.glassdoor.com/job-listing/1',
          location: 'Sofia, BG',
          description: 'SAPUI5 and Fiori Elements development for a remote team.',
          date_posted: '2026-10-05',
        },
      },
    ]);

    const after = (await query<any>(SELECT.from(db().Jobs).where({ company: 'Adventure Works Digital' })))[0];
    expect(after.description).toContain('SAPUI5');
    expect(after.datePosted).toBe('2026-10-05');
    expect(after.firstSeenAt).toBe(originalFirstSeen);
    expect(after.lastSeenAt >= originalFirstSeen).toBe(true);
  });

  it('collapses the same listing appearing twice inside one batch', async () => {
    const before = (await query(SELECT.from(db().Jobs))).length;
    const duplicate = record({
      id: 'li-dup',
      company: 'Litware Analytics BV',
      title: 'SAP AI Developer',
      job_url: 'https://www.linkedin.com/jobs/view/999',
      description: 'Freelance remote role building RAG solutions on SAP AI Core with embeddings in the HANA Vector Engine.',
    });
    const result = await ingest([
      { source: 'linkedin', data: duplicate },
      { source: 'linkedin', data: duplicate },
    ]);
    expect(result.created).toBe(1);
    expect((await query(SELECT.from(db().Jobs))).length).toBe(before + 1);
  });

  it('rejects a duplicate job fingerprint at the database level', async () => {
    const { Jobs } = db();
    const now = new Date().toISOString();
    const row = {
      fingerprint: 'constraint-test',
      title: 'x',
      primaryUrl: 'https://example.com/x',
      firstSeenAt: now,
      lastSeenAt: now,
    };
    await cds.run(INSERT.into(Jobs).entries({ ...row }));
    await expect(cds.run(INSERT.into(Jobs).entries({ ...row }))).rejects.toThrow();
  });
});
