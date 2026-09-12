import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    host: '127.0.0.1',   // 显式绑 IPv4：绑定 localhost 时 Node 可能只监听 ::1，127.0.0.1 会连不上
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
