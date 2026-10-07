import { createRequire } from 'node:module';
import { connectDb, disconnectDb } from '../../src/db/index.js';

// Pause after reading the old columns, while CAP still owns the migration's
// writer lock. The second process must wait before it can read those columns.
const require = createRequire(import.meta.url);
const SQLiteService = require('@cap-js/sqlite');
const original = SQLiteService.prototype.onPlainSQL;
let release: (() => void) | undefined;
SQLiteService.prototype.onPlainSQL = async function (request: { query: unknown }, next: unknown) {
  const result = await original.call(this, request, next);
  if (request.query === 'PRAGMA table_info(sap_jobradar_Notifications)') {
    const released = process.env.JOB_RADAR_TEST_HOLD_SCHEMA === 'true'
      ? new Promise<void>((resolve) => { release = resolve; })
      : Promise.resolve();
    process.send?.({ type: 'schema-read' });
    await released;
  }
  return result;
};

process.on('message', async (message: { type?: string }) => {
  if (message.type === 'release') { release?.(); return; }
  if (message.type !== 'start') return;
  process.send?.({ type: 'starting' });
  try {
    await connectDb(process.env.JOB_RADAR_TEST_DB_PATH);
    await disconnectDb();
    process.send?.({ type: 'done' });
    process.disconnect();
  } catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
});
process.send?.({ type: 'ready' });
