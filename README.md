# mazi — AI Agent Harness（MVP）

依据《[总体设计文档 v1.2](docs/总体设计文档v1.2.md)》裁剪实现的 Agent 执行框架 MVP，设计契约见《[MVP 设计文档 v1.0](docs/MVP设计文档v1.0.md)》。

## 快速开始（CLI 演示，确定性 ScriptedDriver）

```bash
pnpm install
pnpm build
node apps/cli/dist/cli.js run "读取 README.md 并汇报" \
  --config-dir apps/cli/config --event-dir ./events-demo
```

- 事件 JSONL 落盘于 `./events-demo/<sessionId>.jsonl`（审计不丢失）。
- `--interactive` 可在执行后输入 1–5 评分，写入用户交互记录。
- 默认驱动为 `scripted`（确定性模拟，无需 API 凭据）；真实厂商接入通过 `LLMDriver` 注入扩展（防腐层，接口见 `packages/core/src/provider.ts`）。

## 测试与质量门禁

```bash
pnpm check        # biome lint + vitest（118+ 用例）
pnpm build        # turbo tsc -b 全量构建
```

## 包布局

- `packages/core`：全部契约类型（零运行时依赖，唯一运行时工具 `ulid()`）
- L1：observability / flags / provider-llm / usage / policy / memory
- L2：planner / executor / recovery / user-profile
- L3：strategy-full-loop → harness-runtime（装配）→ apps/cli

## MVP 验收对照

验收项 A1–A15（MVP 设计文档 §6）由各 feature 测试覆盖；端到端场景见 `packages/harness-runtime/src/harness-runtime.test.ts`。
