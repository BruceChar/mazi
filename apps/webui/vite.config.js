import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 开发/预览配置：
 * - host/port 可经 MAZI_UI_HOST / MAZI_UI_PORT 覆盖（默认 localhost:5174，浏览器以
 *   http://localhost:5174 打开）；
 * - /api 代理目标经 MAZI_API_TARGET 覆盖，默认 http://localhost:4317
 *   （与 API 端 MAZI_SERVER_PORT 对应；用 localhost 而非 127.0.0.1，
 *   兼容本机 IPv6/localhost 解析差异，UI 保持同源，无跨域/CSP 告警）。
 */
const API_TARGET = process.env.MAZI_API_TARGET ?? 'http://localhost:4317';
const UI_HOST = process.env.MAZI_UI_HOST ?? '0.0.0.0';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: UI_HOST,
    port: Number.parseInt(process.env.MAZI_UI_PORT ?? '5174', 10),
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: UI_HOST,
    port: Number.parseInt(process.env.MAZI_UI_PORT ?? '5174', 10),
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
