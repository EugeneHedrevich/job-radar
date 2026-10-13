import { connectDb, disconnectDb } from '../db/index.js';
import { createDashboardServer } from './server.js';
import { refreshDeterministicAssessments } from '../pipeline/rank.js';

const port = Number(process.env.JOB_RADAR_PORT?.trim() || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('JOB_RADAR_PORT must be a valid port');
await connectDb();
await refreshDeterministicAssessments();
const server = createDashboardServer();
server.on('error', async (error) => { console.error(error.message); await disconnectDb(); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log(`Job Radar dashboard: http://127.0.0.1:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(async () => { await disconnectDb(); process.exit(0); }));
}
