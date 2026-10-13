import { cds } from '../db/index.js';

/** Cancel only outstanding work; preserve assessments, delivery and tracking history. */
export async function suppressIgnoredWork(connection: any = cds, jobId?: string): Promise<void> {
  const scope = jobId ? ' AND ID = ?' : '';
  const ids = `SELECT ID FROM sap_jobradar_Jobs WHERE status = 'Ignored'${scope}`;
  const params = jobId ? [jobId] : [];
  await connection.run(`UPDATE sap_jobradar_AiAssessmentQueue SET status = 'Superseded'
    WHERE status IN ('Pending', 'RetryPending') AND job_ID IN (${ids})`, params);
  await connection.run(`UPDATE sap_jobradar_Notifications SET status = 'Skipped', claimToken = NULL,
    claimUntil = NULL, lastError = 'Job is Ignored'
    WHERE (status IN ('Pending', 'Failed') OR
      (status = 'Sending' AND (claimUntil IS NULL OR claimUntil <= ?))) AND job_ID IN (${ids})`,
  [new Date().toISOString(), ...params]);
}
