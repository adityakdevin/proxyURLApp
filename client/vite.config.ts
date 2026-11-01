import { createRequire } from 'module';
import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// pdf.js 5+ decodes JPEG 2000, JBIG2 and CCITT fax images (black-and-white office scans)
// with wasm it fetches at runtime from `wasmUrl`; DocumentViewer points that at the site
// root. Served from the pdfjs-dist react-pdf resolves, so the versions match.
// ponytail: the wasm dir IS the public dir; a real public/ folder would need a copy plugin.
const require = createRequire(import.meta.url);
const pdfjsWasmDir = normalizePath(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'wasm'));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  // Served at / in dev and copied as-is to the dist root at build.
  publicDir: pdfjsWasmDir,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/proxy': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
