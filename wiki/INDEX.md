# mazi

> 一句话：面向复杂真实任务的 AI Agent Harness——把「模型的判断」与「harness 的事实」严格分层，让执行可验证、可回滚、可审计。
> 技术栈：TypeScript monorepo（Node.js ≥26 · pnpm ≥10 · Turborepo）；NestJS+Fastify 后端，Vue 3+Vite 前端，Vitest+Biome 质量门。

## 速查
| 想知道 | 去哪 |
|---|---|
| 架构与模块 | overview/architecture.md |
| 怎么写代码 | overview/conventions.md |
| 常用命令 | overview/commands.md |
| 部署与环境 | overview/deployment.md |
| 当前进行中的事 | state/current.md |
| 历史决策 | overview/decisions/ |
| 还没做的产品功能 | `docs/TODO.md`（唯一待办清单） |

## 红线（违反会出 bug）
1. **判断与事实分层**：模型只产出判断，事实必须由 harness 记录并可与日志重建；不得让模型自报的“完成”成为唯一证据。
2. **事件只追加**：无 update/delete 事件 API，`seq` 为排序权威、`prevHash/hash` 为哈希链；改动不得破坏可回放与可归因。
3. **归因链闭合 + 治理单调递减**：任何 Goal 必须回溯到 human/system 根 Goal；`permissionCeiling`/`budget` 不得放大，唯一升权路径是人工审批。
4. **不可裁剪安全下限**：secret 必断流（R3-hard）、fail-closed + 默认 forbidden、审计只追加、secret 句柄永不解析为明文 egress。
5. **契约层不得依赖实现**：`packages/core` 不引入下层实现依赖；依赖方向单向向下，界面只消费 API 与共享类型。
6. **文档优先 + 测试先行**：先写设计与接口文档，再写测试，最后写实现（见 `AGENTS.md`）；不得通过跳过/删除测试制造通过。

## 模块地图
| 路径 | 职责 | 技术栈 | 模块 wiki |
|---|---|---|---|
| apps/api | REST + SSE 服务：会话运行、工作区、Goal 快照、审批、事件、模型目录/用量、存储、健康 | NestJS + Fastify | 未初始化 |
| apps/webui | 生产界面：对话流、实时指标、Context 投影、审计、存储、审批门、设置 | Vue 3 + Vite | 未初始化 |
| packages/core | 契约层：Goal-Task-Step、authz、观测事件、provider 契约、usage | TypeScript | 未初始化 |
| packages/libs | 跨端共享类型（Goal 树投影等） | TypeScript | 未初始化 |
| packages/provider | 厂商适配：DeepSeek、pi-ai 适配器、模型发现、官方价目解析 | TypeScript | 未初始化 |
| packages/runtime | 执行实现：Goal 编排、ToolGateway、事件总线、Provider 供给、上下文与 Project Wiki | TypeScript | 未初始化 |

## 最近更新
<!-- recent:start -->
- 356be84 2026-11-08 15:18:32 wiki(checkpoint): sync state & index
- a509b0d 2026-11-08 15:18:27 wiki(run): record session activity
- fd77ddd 2026-11-08 15:18:20 wiki(claim): verify project-context-lifecycle-runtime,project-wiki-maintenance-actions-runtime,project-wiki-run-activity-runtime,project-wiki-incremental-preflight-runtime,project-wiki-fact-lifecycle
- 99b3bb8 2026-11-08 15:17:11 wiki(claim): verify wiki-ui-three-pane,wiki-init-domain-neutral-template,project-context-lifecycle-runtime
- cb90b3f 2026-11-08 15:17:06 wiki(claim): update wiki-ui-current-status-facts-trace
- a94696d 2026-11-08 15:17:02 wiki(claim): update wiki-ui-repository-view
- 5cfc96b 2026-11-08 15:16:54 wiki(claim): add project-wiki-fact-lifecycle
- 56c9295 2026-11-08 15:16:49 wiki(claim): correct project-wiki-incremental-preflight -> project-wiki-incremental-preflight-runtime
<!-- recent:end -->
