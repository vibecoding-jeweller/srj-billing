import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // pdf.js and the embedded fonts are large; that's fine for an offline desktop app
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 4000 },
  test: { include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] },
});
