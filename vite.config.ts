import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built app is served by the Worker as static assets from public/.
// In dev, `wrangler dev` (8787) serves /api and Vite proxies to it.
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../public', emptyOutDir: false, assetsDir: 'app' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
