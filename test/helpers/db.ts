import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cds, connectDb, db, DELETE, disconnectDb } from '../../src/db/index.js';

/** Connect to a throwaway SQLite file so tests never touch the real database. */
export async function useTempDb(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'job-radar-test-'));
  const file = path.join(dir, 'test.sqlite');
  await connectDb(file);
  return file;
}

export async function closeTempDb(): Promise<void> {
  await disconnectDb();
}

/** Isolate scenarios, including durable queues and observation history. */
export async function resetTestDb(): Promise<void> {
  for (const name of ['CollectionLease', 'CollectionOperations', 'FollowUpReminders', 'ListingActivityEvents', 'AiAssessmentQueue', 'Notifications', 'Assessments',
    'SourceListings', 'Jobs', 'CollectionErrors', 'CollectionTasks', 'CollectionRuns', 'SourceHealth', 'DescriptionRotation', 'SearchProgress'] as const) {
    await cds.run(DELETE.from(db()[name]));
  }
}
