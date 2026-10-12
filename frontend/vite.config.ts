import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, 'JOB_RADAR_');
  const port = process.env.JOB_RADAR_PORT?.trim() || env.JOB_RADAR_PORT?.trim() || '3210';
  return {
    root, envDir: projectRoot, plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } } },
    build: { outDir: '../dist/dashboard', emptyOutDir: true },
  };
});
