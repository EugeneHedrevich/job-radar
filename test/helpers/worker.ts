import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../../src/config/index.js';

export interface WorkerEvent { type: string; message?: string }
export interface TestWorker<T extends WorkerEvent> {
  child: ChildProcess;
  events: T[];
  wait(type: string): Promise<T>;
}

/** Offline process fixtures for notification and migration races. */
export function startTestWorker<T extends WorkerEvent>(script: string, env: Record<string, string>): TestWorker<T> {
  const child = fork(path.join(PROJECT_ROOT, 'test/helpers', script), [], {
    cwd: PROJECT_ROOT, execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, ...env, OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
  });
  const events: T[] = [];
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout?.resume();
  child.on('message', (event: T) => { events.push(event); });
  return { child, events, wait(type) {
    return new Promise((resolve, reject) => {
      const settle = (event: T) => event.type === type ? resolve(event) : reject(new Error(event.message));
      const existing = events.find((event) => event.type === type || event.type === 'error');
      if (existing) { settle(existing); return; }
      const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); };
      const onMessage = (event: T) => {
        if (event.type === type || event.type === 'error') { cleanup(); settle(event); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker did not emit ${type}: ${stderr}`)); }, 7000);
      child.on('message', onMessage);
    });
  } };
}
