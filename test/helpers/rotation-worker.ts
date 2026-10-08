import { loadConfig } from '../../src/config/index.js';
import { reserveBatchPlan } from '../../src/collector/rotation.js';
import { connectDb, disconnectDb } from '../../src/db/index.js';

await connectDb(process.argv[2]);
try {
  const plan = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
  const descriptions = [...plan.tasksBySource.values()].flat().filter((task) => task.fetch_description);
  process.stdout.write(`ROTATION ${JSON.stringify(descriptions.map((task) => `${task.source}:${task.search_term}`))}\n`);
} finally { await disconnectDb(); }
