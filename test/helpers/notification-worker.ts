import { connectDb, disconnectDb } from '../../src/db/index.js';
import { notify } from '../../src/pipeline/notify.js';

let release: (() => void) | undefined;
process.on('message', async (message: { type?: string }) => {
  if (message.type === 'release') { release?.(); return; }
  if (message.type !== 'start') return;
  try {
    const summary = await notify({ client: {
      async send() {
        const released = new Promise<void>((resolve) => { release = resolve; });
        process.send?.({ type: 'delivery' });
        await released;
        return { ok: true, messageId: 42, retryable: false };
      },
    } });
    await disconnectDb();
    process.send?.({ type: 'done', summary });
    process.disconnect();
  } catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    await disconnectDb();
    process.exit(1);
  }
});

await connectDb(process.env.JOB_RADAR_TEST_DB_PATH);
process.send?.({ type: 'ready' });
