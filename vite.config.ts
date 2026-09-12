import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:1921',
        changeOrigin: true,
      },
    },
  },
  envPrefix: ['VITE_'],
  build: {
    target: ['es2022', 'chrome100'],
    minify: 'esbuild',
    // 打包分发版(无源码映射, 防源码随包泄漏); 开发调试默认仍带 sourcemap
    sourcemap: process.env.QBM_DIST_NO_MAP === '1' ? false : true,
  },
});
