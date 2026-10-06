/** Minimal structured logger. Everything goes to stderr so that any machine
 *  readable output we print on stdout stays clean. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.JOB_RADAR_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const suffix = extra === undefined ? '' : ` ${safeJson(extra)}`;
  process.stderr.write(`${stamp} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => emit('debug', message, extra),
  info: (message: string, extra?: unknown) => emit('info', message, extra),
  warn: (message: string, extra?: unknown) => emit('warn', message, extra),
  error: (message: string, extra?: unknown) => emit('error', message, extra),
};

/** Anything printed for the user (tables, notification previews) goes here. */
export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}
