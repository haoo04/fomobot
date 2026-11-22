import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
  const env = loadEnv(mode, workspaceRoot, '');
  const webOrigin = new URL(env.WEB_ORIGIN || 'http://localhost:5173');
  const apiTarget = `http://127.0.0.1:${env.PORT || '3001'}`;

  return {
    plugins: [react()],
    server: {
      host: webOrigin.hostname,
      port: Number(webOrigin.port || 80),
      strictPort: true,
      proxy: { '/api': apiTarget, '/health': apiTarget },
    },
  };
});
