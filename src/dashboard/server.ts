import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';
import { ApiError, listJobs, readCollectionStatus, readJob, updateTracking } from './store.js';

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new ApiError(415, 'Use application/json for tracking updates');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128_000) throw new ApiError(413, 'Tracking update is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function staticFile(response: ServerResponse, pathname: string, directory: string, head: boolean): Promise<void> {
  const root = path.resolve(directory);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new ApiError(400, 'Invalid URL'); }
  let file = path.resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!file.startsWith(`${root}${path.sep}`)) throw new ApiError(404, 'Not found');
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new ApiError(404, 'Not found');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    if (path.extname(decoded)) throw new ApiError(404, 'Not found');
    file = path.join(root, 'index.html');
  }
  let data: Buffer;
  try { data = await readFile(file); }
  catch (error: any) {
    if (error.code === 'ENOENT') throw new ApiError(503, 'Dashboard build missing. Run npm run build, or use npm run dev.');
    throw error;
  }
  response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
  response.end(head ? undefined : data);
}

/** A local HTTP wrapper around stored reads and the sole tracking write path. */
export function createDashboardServer(frontendDirectory = path.join(PROJECT_ROOT, 'dist/dashboard')) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const host = request.headers.host ?? '';
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new ApiError(403, 'Local access only');
      const origin = request.headers.origin;
      if (origin && ![`http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin)) {
        throw new ApiError(403, 'Origin not allowed');
      }
      if (url.pathname === '/api/jobs' && request.method === 'GET') {
        json(response, 200, await listJobs(url.searchParams)); return;
      }
      if (url.pathname === '/api/status' && request.method === 'GET') {
        json(response, 200, await readCollectionStatus()); return;
      }
      const match = /^\/api\/jobs\/([^/]+)(\/tracking)?$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        if (!match[2] && request.method === 'GET') {
          json(response, 200, await readJob(id)); return;
        }
        if (match[2] && request.method === 'PATCH') {
          json(response, 200, await updateTracking(id, await body(request))); return;
        }
        throw new ApiError(405, 'Method not allowed');
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) throw new ApiError(404, 'API route not found');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Method not allowed');
      await staticFile(response, url.pathname, frontendDirectory, request.method === 'HEAD');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Dashboard request failed:', error);
      json(response, error instanceof ApiError ? error.status : 500,
        { error: error instanceof ApiError ? error.message : 'Unable to read or save dashboard data' });
    }
  });
}
