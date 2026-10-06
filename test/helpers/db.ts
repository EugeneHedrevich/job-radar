import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectDb, disconnectDb } from '../../src/db/index.js';

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
