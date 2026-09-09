import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

/**
 * 开发/预览配置：
 * - 端口与代理目标从配置读取（单一配置源 apps/api/.env：MAZI_SERVER_PORT /
 *   MAZI_WEBUI_PORT / MAZI_WEBUI_HOST），启动时经 loadEnv 加载；
 * - 环境变量可覆盖：MAZI_API_TARGET（代理目标）、MAZI_WEBUI_PORT /
 *   MAZI_UI_PORT（UI 端口，后者为兼容旧名）、MAZI_WEBUI_HOST / MAZI_UI_HOST；
 * - 代理用 localhost 而非 127.0.0.1（兼容本机 IPv6/localhost 解析差异，
 *   UI 保持同源，无跨域/CSP 告警）。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname, '../api'), '');

  const apiPort = process.env.MAZI_SERVER_PORT ?? env.MAZI_SERVER_PORT ?? '4317';
  const API_TARGET =
    process.env.MAZI_API_TARGET ?? `http://localhost:${apiPort}`;

  const UI_HOST =
    process.env.MAZI_WEBUI_HOST ??
    process.env.MAZI_UI_HOST ??
    env.MAZI_WEBUI_HOST ??
    '0.0.0.0';
  const UI_PORT = Number.parseInt(
    process.env.MAZI_WEBUI_PORT ??
      process.env.MAZI_UI_PORT ??
      env.MAZI_WEBUI_PORT ??
      '5174',
    10,
  );

  return {
    plugins: [vue()],
    server: {
      host: UI_HOST,
      port: UI_PORT,
      proxy: {
        '/api': { target: API_TARGET, changeOrigin: true },
      },
    },
    preview: {
      host: UI_HOST,
      port: UI_PORT,
      proxy: {
        '/api': { target: API_TARGET, changeOrigin: true },
      },
    },
  };
});
