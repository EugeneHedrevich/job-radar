import { randomUUID } from 'node:crypto';
import { cds, db, INSERT, SELECT, UPDATE, query } from '../db/index.js';
import type { ListingActivity } from '../collector/types.js';
import { canonicalizeUrl } from '../util/text.js';

/** Unknown/missing listings are never evidence of closure. */
export async function closedJobIds(connection: any = cds): Promise<Set<string>> {
  const rows = await connection.run(`SELECT job_ID FROM sap_jobradar_SourceListings
    WHERE job_ID IS NOT NULL GROUP BY job_ID
    HAVING COUNT(*) = SUM(CASE WHEN activityState = 'Closed' THEN 1 ELSE 0 END)`);
  return new Set(rows.map((row: { job_ID: string }) => row.job_ID));
}

export async function isJobClosed(jobId: string): Promise<boolean> {
  const listings = await query<{ activityState: string | null }>(SELECT.from(db().SourceListings)
    .columns('activityState').where({ job_ID: jobId }));
  return listings.length > 0 && listings.every((listing) => listing.activityState === 'Closed');
}

/** Apply only explicit observations, including closures returned by failed tasks.
 * A search result cannot silently reopen a listing. Keep all activity history. */
export async function applyListingActivity(observations: ListingActivity[]): Promise<void> {
  if (!observations.length) return;
  await cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    for (const observation of observations) {
      const url = canonicalizeUrl(observation.job_url);
      let listing = observation.source_job_id && await tx.run(SELECT.one.from(db().SourceListings)
        .where({ source: observation.source, sourceJobId: observation.source_job_id }));
      listing ||= await tx.run(SELECT.one.from(db().SourceListings)
        .where({ source: observation.source, canonicalUrl: url }));
      if (!listing) continue;
      const state = observation.status === 'closed' ? 'Closed' : 'Active';
      const checked = new Date(observation.checked_at).getTime();
      const previous = listing.activityCheckedAt ? new Date(listing.activityCheckedAt).getTime() : -Infinity;
      if (checked < previous || checked === previous && (listing.activityState === state || listing.activityState === 'Closed')) continue;
      await tx.run(INSERT.into(db().ListingActivityEvents).entries({
        ID: randomUUID(), listing_ID: listing.ID, state, reason: observation.reason ?? null,
        evidence: observation.evidence.slice(0, 1900), checkedAt: observation.checked_at,
      }));
      await tx.run(UPDATE(db().SourceListings).set({ activityState: state,
        activityCheckedAt: observation.checked_at, closureReason: observation.reason ?? null,
        activityEvidence: observation.evidence.slice(0, 1900) }).where({ ID: listing.ID }));
    }
    const closed = await closedJobIds(tx);
    if (closed.size) await tx.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Superseded' })
      .where({ job_ID: { in: [...closed] }, status: 'Pending' }));
  });
}
