import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cds, db, INSERT, query, queryOne, SELECT } from '../src/db/index.js';
import { notify, type NotifySummary } from '../src/pipeline/notify.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { ingestReview } from './helpers/review.js';
import { startTestWorker, type TestWorker } from './helpers/worker.js';
interface Event {
    type: string;
    message?: string;
    summary?: NotifySummary;
}
type Worker = TestWorker<Event>;
const workers: Worker[] = [];
let dbPath: string;
function startWorker(): Worker {
    const worker = startTestWorker<Event>('notification-worker.ts', { JOB_RADAR_TEST_DB_PATH: dbPath });
    workers.push(worker);
    return worker;
}
beforeAll(async () => { dbPath = await useTempDb(); });
afterAll(closeTempDb);
beforeEach(async () => {
    await resetTestDb();
    await ingestReview();
    await rank({ rulesOnly: true });
});
afterEach(() => {
    for (const worker of workers.splice(0)) {
        if (worker.child.exitCode === null)
            worker.child.kill();
    }
});
describe('notifications from independent processes', () => {
    it.each([false, true])('sends once when two processes overlap, existing queue: %s', async (alreadyQueued) => {
        if (alreadyQueued)
            await notify({ dryRun: true, client: { async send() { return { ok: true, retryable: false }; } } });
        const first = startWorker();
        const second = startWorker();
        await Promise.all([first.wait('ready'), second.wait('ready')]);
        let deliveryTimer: ReturnType<typeof setTimeout>;
        const delivered = new Promise<Worker>((resolve, reject) => {
            deliveryTimer = setTimeout(() => reject(new Error('Neither process claimed delivery')), 6000);
            for (const worker of [first, second])
                worker.child.on('message', (event: Event) => {
                    if (event.type === 'delivery') {
                        clearTimeout(deliveryTimer);
                        resolve(worker);
                    }
                    if (event.type === 'error') {
                        clearTimeout(deliveryTimer);
                        reject(new Error(event.message));
                    }
                });
        });
        first.child.send({ type: 'start' });
        second.child.send({ type: 'start' });
        const winner = await delivered;
        const other = winner === first ? second : first;
        // Keep the winning sender blocked until the other process has completed.
        // A second send would hang that process and fail this assertion.
        expect((await other.wait('done')).summary!.sent).toBe(0);
        winner.child.send({ type: 'release' });
        expect((await winner.wait('done')).summary!.sent).toBe(1);
        expect([...first.events, ...second.events].filter((event) => event.type === 'delivery')).toHaveLength(1);
        expect(await query(SELECT.from(db().Notifications))).toHaveLength(1);
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Sent', attempts: 1, claimToken: null });
    }, 15000);
    it('keeps legacy duplicate history while preventing delivery when one copy was already sent', async () => {
        await notify({ dryRun: true, client: { async send() { return { ok: true, retryable: false }; } } });
        const original = await queryOne<any>(SELECT.from(db().Notifications));
        await cds.run('DROP INDEX idx_notification_job_channel');
        await cds.run(INSERT.into(db().Notifications).entries({ ...original, ID: randomUUID(), status: 'Sent', telegramMessageId: 42 }));
        const worker = startWorker();
        await worker.wait('ready');
        worker.child.send({ type: 'start' });
        expect((await worker.wait('done')).summary!.sent).toBe(0);
        const rows = await query<any>(SELECT.from(db().Notifications));
        expect(rows).toHaveLength(2);
        expect(rows.filter((row) => row.status === 'Sent')).toHaveLength(1);
        expect(rows.filter((row) => row.status === 'Superseded')).toHaveLength(1);
        expect(worker.events.filter((event) => event.type === 'delivery')).toHaveLength(0);
    }, 15000);
});
