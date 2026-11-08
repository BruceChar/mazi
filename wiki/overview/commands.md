# 命令

> 事实来源：根 `package.json` scripts 与 `README.md` §9「快速开始」。

## 安装与启动

```bash
pnpm install                                   # 安装依赖
cp apps/api/.env.example .env                  # 根 .env 为 API 与 WebUI 共享配置源
pnpm api:dev                                   # API: http://127.0.0.1:6294，前缀 /api
pnpm ui:dev                                    # WebUI: 端口取根 .env 的 MAZI_WEBUI_PORT
```

环境要求：Node.js ≥ 26、pnpm ≥ 10。

## npm scripts
- `build` → `turbo run build`
- `clean` → `turbo run clean; rm -rf .turbo`
- `clear` → `turbo run clean; rm -rf .turbo`
- `test` → `vitest run --passWithNoTests`
- `test:watch` → `vitest --passWithNoTests`
- `lint` → `biome check .`
- `lint:fix` → `biome check --write .`
- `fmt` → `biome format --write .`
- `fmt:check` → `biome format .`
- `check` → `pnpm lint && pnpm test`
- `prepare` → `husky`
- `api:dev` → `pnpm --filter @mazi/api dev`
- `api:prod` → `pnpm --filter @mazi/api start`
- `ui:dev` → `pnpm --filter @mazi/webui dev`
- `ui:prod` → `pnpm --filter @mazi/webui start`（构建并托管 WebUI 静态产物）

## 运行时配置

- 模型 API Key：优先在 WebUI「设置」填入（写入本地 `secrets.json`，权限 0600、界面遮蔽展示）；
  也可用环境变量 `DEEPSEEK_API_KEY`。
- 运行数据默认落在 `MAZI_HOME`（默认 `~/.mazi`）。

## 验证纪律

- 提交前跑 `pnpm check`（= lint + test）；跨包改动再加 `pnpm build`。
- 改动 runtime 后需重启 API 进程（stale dist 会导致行为看似未生效）。
- 只读探索类任务不能用 "无 git diff" 推断无改动，先看 `git status` 与工作区事实。
