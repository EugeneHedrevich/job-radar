import { randomUUID } from 'node:crypto';
import { cds, db, SELECT, queryOne } from '../db/index.js';

interface Candidate {
  jobId: string;
  assessmentId: string;
  channel: string;
  chatId: string | null;
  payload: string;
}

/** Insert or reactivate once, even if two notification runs selected this job. */
export async function queueNotification(candidate: Candidate): Promise<boolean> {
  const result = await cds.run(`INSERT INTO sap_jobradar_Notifications
    (ID, job_ID, assessment_ID, channel, status, attempts, chatId, payload, createdAt)
    VALUES (?, ?, ?, ?, 'Pending', 0, ?, ?, ?)
    ON CONFLICT(job_ID, channel) WHERE status != 'Superseded' DO UPDATE SET
      assessment_ID = excluded.assessment_ID, status = 'Pending', attempts = 0,
      chatId = excluded.chatId, payload = excluded.payload,
      createdAt = excluded.createdAt, lastError = NULL, claimToken = NULL, claimUntil = NULL
    WHERE sap_jobradar_Notifications.status = 'Skipped'`,
  [randomUUID(), candidate.jobId, candidate.assessmentId, candidate.channel,
    candidate.chatId, candidate.payload, new Date().toISOString()]);
  return Number(result.changes) === 1;
}

/** A committed compare-and-set owns delivery; no lock is held during the send. */
export async function claimNotification(id: string, maxAttempts: number, dryRun: boolean): Promise<any | undefined> {
  const token = randomUUID();
  const now = new Date();
  // The Telegram client times out in 20 seconds. Five minutes allows ample
  // time to finish and persist a response, with recovery after process loss.
  const until = new Date(now.getTime() + 5 * 60_000).toISOString();
  const result = await cds.run(`UPDATE sap_jobradar_Notifications
    SET status = 'Sending', claimToken = ?, claimUntil = ?, attempts = attempts + ?
    WHERE ID = ? AND attempts < ? AND
      (status IN ('Pending', 'Failed') OR (status = 'Sending' AND claimUntil <= ?))`,
  [token, until, dryRun ? 0 : 1, id, maxAttempts, now.toISOString()]);
  if (Number(result.changes) !== 1) return undefined;
  return queryOne(SELECT.from(db().Notifications).where({ ID: id, claimToken: token, status: 'Sending' }));
}
