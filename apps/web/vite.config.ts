import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// 火山 RTC / getUserMedia 需安全上下文（localhost 或 HTTPS）。
// 真机 LAN 测试要 HTTPS → basicSsl 自签证书；dev server 反代 /api + /v1 到后端。
// VITE_NO_HTTPS=1 关自签（localhost 本身是 secure context；preview/无头浏览器用，P003 同款范式）。
export default defineConfig({
  plugins: [react(), ...(process.env.VITE_NO_HTTPS === '1' ? [] : [basicSsl()])],
  server: {
    host: true, // 监听 0.0.0.0，手机同网段可访问
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/v1': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
