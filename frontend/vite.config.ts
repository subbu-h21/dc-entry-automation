import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/extract':        { target: 'http://localhost:3001', changeOrigin: true },
      '/launch-browser': { target: 'http://localhost:3001', changeOrigin: true },
      '/voice':          { target: 'http://localhost:3001', changeOrigin: true },
      '/products':       { target: 'http://localhost:3001', changeOrigin: true },
      '/suppliers':      { target: 'http://localhost:3001', changeOrigin: true },
      '/screenshot':     { target: 'http://localhost:3001', changeOrigin: true },
      '^/inbox(/|$)':    { target: 'http://localhost:3001', changeOrigin: true },
      '/staff':          { target: 'http://localhost:3001', changeOrigin: true },
      // Trailing-slash regex, not a plain '/admin' prefix: bare /admin is
      // the FRONTEND page route (see App.tsx), not a backend endpoint — only
      // /admin/verify-pin etc. exist server-side. A plain prefix would catch
      // the page-load request itself and send it to the backend, where
      // nothing matches it, breaking /admin under `npm run dev` only (prod
      // is unaffected — main.py serves everything on one port there). This
      // leaves the bare page load to fall through to Vite's normal SPA
      // serving, same as /inbox-upload already relies on with no proxy entry
      // at all, while still forwarding every real /admin/* API call.
      '^/admin/':        { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
