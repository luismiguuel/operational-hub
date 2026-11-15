import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            query: ['@tanstack/react-query'],
            kanban: ['@dnd-kit/core'],
            markdown: ['react-markdown', 'rehype-sanitize'],
          },
        },
      },
    },
    server: {
      strictPort: true,
      proxy: { '/api': { target: `http://localhost:${env['PORT'] ?? '3001'}`, ws: true } },
    },
  };
});
