import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 开发/预览配置。
 *
 * 配置源：仓库根 .env（monorepo 单一共享配置，apps/api/.env 不参与），
 * 经 vite 原生 envDir/loadEnv 加载；根 .env 定义：
 *   - MAZI_SERVER_PORT —— api 端口，/api 代理目标据此推导
 *   - MAZI_WEBUI_PORT / MAZI_WEBUI_HOST —— UI 监听地址
 * 环境变量可覆盖：MAZI_API_TARGET（整体覆盖代理目标）、MAZI_WEBUI_PORT /
 * MAZI_WEBUI_HOST（覆盖 UI 地址；MAZI_UI_* 为兼容旧名）。
 * 代理用 localhost 而非 127.0.0.1（兼容本机 IPv6/localhost 解析差异，
 * UI 保持同源，无跨域/CSP 告警）。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_DIR = resolve(__dirname, '../..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, '');

  const apiPort = env.MAZI_SERVER_PORT ?? '4317';
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
    envDir: ENV_DIR,
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
