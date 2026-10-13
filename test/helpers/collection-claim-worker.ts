import { claimCollection } from '../../src/collector/lease.js';
import { connectDb, disconnectDb } from '../../src/db/index.js';

await connectDb(process.env.JOB_RADAR_TEST_DB_PATH);
process.on('message', async (message: { type?: string }) => {
  if (message.type !== 'start') return;
  try {
    const reservation = await claimCollection(process.env.JOB_RADAR_TEST_TRIGGER ?? 'scheduled');
    await disconnectDb();
    process.send?.({ type: 'done', acquired: reservation.acquired,
      operationId: reservation.acquired ? reservation.claim.operationId : reservation.operationId });
    process.disconnect();
  } catch (error) {
    process.send?.({ type: 'error', message: String(error) }); process.exit(1);
  }
});
process.send?.({ type: 'ready' });
