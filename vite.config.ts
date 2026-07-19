import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // 预构建重依赖，加速 dev 冷启（@lobehub/icons 按需 import 不列，整包预构建反而慢）
    include: ['react', 'react-dom', 'antd', '@ant-design/icons', '@heroicons/react/24/outline', 'react-markdown', 'remark-gfm'],
  },
  base: './',
  server: {
    // 验收脚本用 VITE_PORT 指定随机端口；默认 5173 strictPort
    port: parseInt(process.env.VITE_PORT || '5173', 10),
    strictPort: !process.env.VITE_PORT,
    proxy: {
      '/api': {
        // 验收脚本用 LUCENT_WEB_PORT 指向后端随机端口；默认 7049
        target: process.env.LUCENT_WEB_PORT
          ? `http://localhost:${process.env.LUCENT_WEB_PORT}`
          : 'http://localhost:7049',
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
