import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:7049',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 函数式：对象式 manualChunks 对 React 19 / antd 这类 re-export 重的库会失效，
        // 只精确匹配入口 id、不连带 jsx-runtime / scheduler / rc-* 等子依赖 → 产空壳 chunk。
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // 尾部 [\\/] 避免误伤 react-markdown / react-syntax-highlighter 等
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          // antd 全家桶：antd / @ant-design/* / rc-* 子组件
          if (/[\\/]node_modules[\\/](antd|@ant-design|rc-[^\\/]+)[\\/]/.test(id)) {
            return 'vendor-antd';
          }
        },
      },
    },
  },
});
