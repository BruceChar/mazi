# 编码与协作约定

> 事实来源：`README.md` §11「工程文化：文档优先 + 测试先行」（约束写在 `AGENTS.md`，对人和 AI 协作者同时生效）。

## 工作流顺序（强约束）

1. **文档优先**：任何代码实现之前先完成需求/设计/接口文档；文档是验收的唯一依据，跨模块协作以书面契约为准。
2. **测试先行**：文档完成后先写测试定义验收标准，再写生产代码；测试不通过视为未完成。
3. **Bug 修复先补复现用例**。
4. **原子提交**：一次提交只包含一个完整功能点 / 一个修复 / 一次专项优化，禁止跨范围修改。
5. **不过早优化**：没有 profiling 证据不得做性能优化；可读性与可维护性优先。
6. **技术债单独闭环**：代码异味作为独立任务登记，同样遵循「先文档、再测试、后代码」。

## 代码组织

- 语言 TypeScript，monorepo 用 project references；改动前先确认落点在 `core`（契约）/ `provider`（厂商适配）/
  `runtime`（编排与治理）/ `apps`（接口与界面），依赖方向单向向下。
- 质量门：`pnpm lint`（Biome check）、`pnpm test`（Vitest）、`pnpm check`（lint + test）；Husky 管理提交钩子。
- 不得注释、跳过或删除测试来制造通过；失败要如实报告并区分根因、兼容风险与未验证假设。

## 文档地图（改之前先读对应卷）

| 主题 | 文档 |
|---|---|
| 总纲 | `docs/Agent Harness Framework.md` |
| Goal 坐标系 / 权限 / 工具网关 / 观测 / Provider 契约 | `docs/core/AHF_CORE_*.md` |
| 运行时计划、验收、评测与可靠性 | `docs/runtime/*.md` |
| WebUI 与流式响应 | `docs/webui.md`、`docs/web/*.md` |
| 项目 Wiki | `docs/runtime/AHF_PROJECT_WIKI.md`、`docs/项目wiki设计.md` |
| 迁移清单与执行状态 | `docs/C3-goal-migration.md`、`docs/P2-provider-switch.md` |

## 绝不能做的事
1. 破坏 Append-only 观测与归因链（补写/修改历史事件、绕过 `seq`/哈希链）。
2. 放大权限或预算上限；以任何非人工审批方式升权。
3. 让契约层依赖实现层，或让界面直接绕过 API 读内部状态。
4. 把“未做/未验证”写成已完成；在 Wiki 与文档中臆测未确认事实（保留 TODO 并挂证据）。
