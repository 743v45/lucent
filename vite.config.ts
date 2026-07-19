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
    // 关闭 dev 压缩：默认 compression 会缓冲 SSE 流式响应（/api/logs/stream），
    // 导致前端 EventSource 收不到事件。生产用 build 产物，不走 vite dev，不受影响。
    compression: false,
    proxy: {
      '/api': {
        // 验收脚本用 LUCENT_WEB_PORT 指向后端随机端口；默认 7049
        target: process.env.LUCENT_WEB_PORT
          ? `http://localhost:${process.env.LUCENT_WEB_PORT}`
          : 'http://localhost:7049',
        changeOrigin: true,
        // SSE 流式：强制 identity 编码，避免 http-proxy 对压缩响应缓冲，导致 /api/logs/stream
        // 的事件被攒在 proxy 缓冲区里不转发（前端 EventSource 一直 CONNECTING）。
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('accept-encoding', 'identity');
          });
        },
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
