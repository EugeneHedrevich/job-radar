import { useState } from 'react';
import type { FollowUpReminder } from '../../src/dashboard/types';
import { sofiaDate } from '../../src/util/calendar';
import { request } from './api';

function ReminderRow({ reminder, select, changed }: { reminder: FollowUpReminder; select: (id: string) => void; changed: () => void }) {
  const [dueDate, setDueDate] = useState(reminder.dueDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function update(patch: unknown) {
    setBusy(true); setError(null);
    try { await request(`/api/reminders/${encodeURIComponent(reminder.ID)}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); changed(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save reminder'); }
    finally { setBusy(false); }
  }
  const today = sofiaDate();
  return <div className="reminder-row">
    <div><button className="job-title" onClick={() => select(reminder.jobId)}>{reminder.title}</button>
      <span className="muted small">{reminder.company} · CV follow-up</span></div>
    <span className={reminder.dueDate < today ? 'warning small' : 'small'}>{reminder.dueDate < today ? 'Overdue' : reminder.dueDate === today ? 'Due today' : 'Due'} · {reminder.dueDate}</span>
    <div className="reminder-actions"><button disabled={busy} onClick={() => update({ action: 'complete' })}>Complete</button>
      <button disabled={busy} onClick={() => update({ action: 'postpone' })}>+7 days</button>
      <label><span className="sr-only">Follow-up due date for {reminder.title}</span><input type="date" value={dueDate} disabled={busy} onChange={(event) => setDueDate(event.target.value)} /></label>
      {dueDate !== reminder.dueDate && <button disabled={busy || !dueDate} onClick={() => update({ action: 'reschedule', dueDate })}>Save date</button>}</div>
    {error && <p className="error small" role="alert">{error}</p>}
  </div>;
}

export default function Reminders({ items, select, changed }: { items: FollowUpReminder[]; select: (id: string) => void; changed: () => void }) {
  const due = items.filter((item) => item.dueDate <= sofiaDate());
  const upcoming = items.filter((item) => item.dueDate > sofiaDate());
  const rows = (values: FollowUpReminder[]) => values.map((reminder) => <ReminderRow key={`${reminder.ID}:${reminder.dueDate}`} reminder={reminder} select={select} changed={changed} />);
  return <section className="reminders-panel" aria-labelledby="reminders-heading"><div className="progress-heading">
    <h2 id="reminders-heading">Follow-ups <span className="count">{due.length}</span></h2><span className="muted small">Europe/Sofia</span></div>
    {due.length ? rows(due) : <p className="muted small">No follow-ups due today.</p>}
    {upcoming.length > 0 && <details><summary>Upcoming ({upcoming.length})</summary>{rows(upcoming)}</details>}
    <p className="muted small reminder-note">In-app reminders appear when Job Radar is running.</p>
  </section>;
}
