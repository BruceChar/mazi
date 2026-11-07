# 常用命令

### npm scripts
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
- `ui:prod` → `pnpm --filter @mazi/webui start`
