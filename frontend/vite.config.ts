import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/extract': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/launch-browser': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/voice': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/products': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/suppliers': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/screenshot': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/save-dc': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
