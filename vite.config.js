import { defineConfig } from 'vite';

// Tauri expects a fixed port and does its own console clearing.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
    emptyOutDir: true
  }
});
