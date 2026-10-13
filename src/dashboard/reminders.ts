import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cds, db, INSERT, SELECT, UPDATE, query } from '../db/index.js';
import { addCalendarDays, sofiaDate } from '../util/calendar.js';
import type { FollowUpReminder } from './types.js';
import { ApiError } from './errors.js';

export async function syncCvFollowUp(tx: any, previous: any, next: any): Promise<void> {
  const now = new Date().toISOString();
  const pending = await tx.run(SELECT.one.from(db().FollowUpReminders)
    .where({ job_ID: next.ID, kind: 'CvFollowUp', status: 'Pending' }));
  if (!next.cvSent || ['Ignored', 'Rejected'].includes(next.status)) {
    if (pending) await tx.run(UPDATE(db().FollowUpReminders).set({ status: 'Cancelled', updatedAt: now }).where({ ID: pending.ID }));
    return;
  }
  if (!next.cvSentAt) return; // Legacy unknown: ask the user, never invent a date.
  const changed = !previous.cvSentAt || new Date(next.cvSentAt).getTime() !== new Date(previous.cvSentAt).getTime();
  const values = { sentAt: next.cvSentAt, dueDate: addCalendarDays(sofiaDate(new Date(next.cvSentAt)), 7), updatedAt: now };
  if (pending && changed) await tx.run(UPDATE(db().FollowUpReminders).set(values).where({ ID: pending.ID }));
  else if (!pending && (!previous.cvSent || !previous.cvSentAt && changed)) {
    await tx.run(INSERT.into(db().FollowUpReminders).entries({ ID: randomUUID(), job_ID: next.ID,
      kind: 'CvFollowUp', ...values, status: 'Pending', createdAt: now }));
  }
}

export async function listReminders(jobId?: string): Promise<FollowUpReminder[]> {
  const rows = await query(jobId ? SELECT.from(db().FollowUpReminders).where({ job_ID: jobId })
    : SELECT.from(db().FollowUpReminders).where({ status: 'Pending' }));
  const jobs = new Map((await query(SELECT.from(db().Jobs).columns('ID', 'title', 'company'))).map((job) => [job.ID, job]));
  return rows.filter((row) => jobs.has(row.job_ID)).map((row) => ({ ID: row.ID, jobId: row.job_ID,
    title: jobs.get(row.job_ID).title, company: jobs.get(row.job_ID).company ?? null,
    sentAt: row.sentAt, dueDate: row.dueDate, status: row.status, completedAt: row.completedAt ?? null }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.ID.localeCompare(b.ID));
}

const reminderPatch = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete') }).strict(),
  z.object({ action: z.literal('postpone'), days: z.number().int().min(1).max(365).default(7) }).strict(),
  z.object({ action: z.literal('reschedule'), dueDate: z.iso.date() }).strict(),
]);

export async function updateReminder(id: string, input: unknown) {
  const parsed = reminderPatch.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'Choose complete, postpone or a valid due date');
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const row = await tx.run(SELECT.one.from(db().FollowUpReminders).where({ ID: id }));
    if (!row) throw new ApiError(404, 'Reminder not found');
    if (row.status === 'Completed' && parsed.data.action === 'complete') return row;
    if (row.status !== 'Pending') throw new ApiError(409, 'This reminder is no longer pending');
    const now = new Date().toISOString();
    const patch = parsed.data.action === 'complete' ? { status: 'Completed', completedAt: now }
      : { dueDate: parsed.data.action === 'reschedule' ? parsed.data.dueDate
        : addCalendarDays(row.dueDate > sofiaDate() ? row.dueDate : sofiaDate(), parsed.data.days) };
    await tx.run(UPDATE(db().FollowUpReminders).set({ ...patch, updatedAt: now }).where({ ID: id }));
    return { ...row, ...patch };
  });
}
