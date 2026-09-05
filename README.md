# mazi — AI Agent Harness（MVP）

依据《[总体设计文档 v1.2](docs/总体设计文档v1.2.md)》裁剪实现的 Agent 执行框架 MVP。
设计契约：《[MVP 设计文档 v1.0](docs/MVP设计文档v1.0.md)》、真实厂商接入见《[Provider Adapter 设计](docs/ProviderAdapter设计.md)》。

---

## CLI 怎么启动

### 1. 环境要求

- Node.js ≥ 24（实测 v24.x；仓库 engines 声明 ≥26 仅为保守值）
- pnpm ≥ 10

### 2. 安装与构建（首次）

```bash
pnpm install       # 安装 workspace 依赖（含 pi-ai 等）
pnpm build         # turbo tsc -b 全量构建，产出各包 dist/
```

构建产物入口：`apps/cli/dist/cli.js`。

### 3. 命令与选项

仓库根已注册脚本 `mazi`（`node apps/cli/dist/cli.js`），构建后可直接：

```bash
pnpm mazi run "<任务描述>" [选项]     # 执行任务
pnpm mazi config [选项]              # 交互式配置 provider
# 等价于：node apps/cli/dist/cli.js run|config ...
```

> 提示：`pnpm mazi ...` 依赖已构建的 `apps/cli/dist/cli.js`（先执行 `pnpm build`）；
> 也可用 `pnpm run mazi -- run "<任务描述>" [选项]` 显式传参。

| 选项                   | 说明                                                               | 默认                                 |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `--user <id>`        | 用户标识（写入用户交互记录）                                       | 无                                   |
| `--config-dir <dir>` | 配置目录，须含`providers.json` / `tools.json` / `flags.json` | `./config`                         |
| `--event-dir <dir>`  | 事件 JSONL 落盘目录                                                | `./events`（或 `EVENT_LOG_DIR`） |
| `--db <path>`        | SQLite 文件路径（session/turn/step/用户记录）                      | 内存库                               |
| `--interactive`      | 执行后提示输入 1–5 评分（写入记录）                               | 关                                   |
| `--help`             | 帮助                                                               | —                                   |

退出码：`0` = 成功；`1` = 执行失败（outcome=failed）；`2` = 用法/配置错误。

### 4. 配置目录

`providers.json` 中每个 provider 带一个 `driver`：

- **`scripted`**（默认演示，确定性模拟，无需凭据）：示例配置已内置在 `apps/cli/config/`。
- **`pi-ai`**（真实厂商，见下方 §5）：经 `@earendil-works/pi-ai` 调用 OpenAI / Anthropic / DeepSeek / OpenRouter 等。

`tools.json` 声明工具白名单（含 schema、minPermission、副作用域）；`flags.json` 可选覆盖默认 Flag。

**交互式配置（推荐）**：

```bash
pnpm mazi config --config-dir <你的配置目录>   # 默认 ./config
```

向导会列出可选 provider（OpenAI / DeepSeek / 脚本演示），询问要启用的项与模型，
并**检测 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` 是否已设置**，最后生成
`providers.json` / `tools.json` / `flags.json`。生成的真实厂商 driver 通常省略
`apiKeyEnv`——运行时按 provider 默认映射读取环境变量（见下方 §5 说明）。

### 5. 两种运行方式

**方式 A：内置 ScriptedDriver 演示（推荐先跑通）**

```bash
pnpm mazi run "读取 README.md 并汇报" \
  --config-dir apps/cli/config --event-dir ./events-demo
# 等价于：node apps/cli/dist/cli.js run "读取 README.md 并汇报" --config-dir apps/cli/config --event-dir ./events-demo
```

输出示例末尾 `outcome: success | turns: 1 | tokens: … | costUsd: …`；事件 JSONL 完整落在 `./events-demo/<sessionId>.jsonl`。

**方式 B：真实厂商（pi-ai）**

以 OpenAI 为例，新建目录 `config-real/`，`providers.json`：

```jsonc
{
  "providers": [
    {
      "id": "openai-real",
      "vendor": "openai",
      "tags": ["tools"],
      "models": [
        { "id": "gpt-4o-mini", "contextWindow": 128000,
          "supportsTools": true, "supportsThinking": false, "supportsVision": true }
      ],
      "driver": {
        "type": "pi-ai",
        "provider": "openai",          // pi-ai provider id（openai/anthropic/google/deepseek/openrouter/…）
        "model": "gpt-4o-mini",        // 须在 pi-ai 模型目录内
        "apiKeyEnv": "OPENAI_API_KEY"  // 读取该环境变量；缺失则首次调用报错
      },
      "pricing": { "currency": "USD",
        "base": { "inputPerMTok": 0.15, "outputPerMTok": 0.6 },
        "tiers": [], "effectiveAt": 0, "version": "0.1.0" },
      "health": { "score": 1.0 }
    }
  ]
}
```

`tools.json` 与内置示例相同（见 `apps/cli/config/tools.json`）。然后：

```bash
export OPENAI_API_KEY=sk-...            # 或设 apiKeyEnv 指定的其它变量
pnpm mazi run "读取 README.md 并汇报" \
  --config-dir config-real --event-dir ./events-real
```

> 说明：
> - pi-ai 只包含支持工具调用的模型；模型名须在 pi-ai 目录内（不匹配会给出明确报错）。
> - **默认读取环境变量**：provider=openai → `OPENAI_API_KEY`；provider=deepseek → `DEEPSEEK_API_KEY`；
>   anthropic → `ANTHROPIC_API_KEY` 等。`driver.apiKeyEnv` 可覆盖为其它变量名。
> - 命中默认映射但对应环境变量缺失 → 首次调用即报“缺少 API key：… ${变量名}”的清晰错误。
> - 无鉴权本地端点（Ollama 等 OpenAI 兼容服务）走 pi-ai 自身的自定义 provider 配置扩展。

### 6. 反馈与数据落盘

- 加 `--interactive` 后可在执行完成时输入 1–5 评分；评分写入该会话的用户交互记录（`user_profile` 模块，SQLite `user_interactions` 表）。
- 事件流（session/turn/step/llm/tool/policy/usage…）始终异步落盘 JSONL，与任何 Flag 无关（关闭 ≠ 数据丢失）。
- 更细的用户记录/画像查询接口见 `packages/user-profile`。

---

## 测试与质量门禁

```bash
pnpm check        # biome lint + vitest（当前 129 用例）
pnpm build        # turbo tsc -b 全量构建
pnpm exec vitest run packages/<pkg>/src   # 单包测试
```

## 包布局

- `packages/core`：全部契约类型（零运行时依赖，唯一运行时工具 `ulid()`）
- L1：observability / flags / provider-llm（含 pi-ai 真实厂商 Driver）/ usage / policy / memory
- L2：planner / executor / recovery / user-profile
- L3：strategy-full-loop → harness-runtime（装配）→ apps/cli

## 验收对照

- MVP 验收 A1–A15：见 `docs/MVP设计文档v1.0.md` §6，端到端测试在 `packages/harness-runtime/src/harness-runtime.test.ts`。
- Provider Adapter 验收 PA-A1~A5：见 `docs/ProviderAdapter设计.md` §4。
---

## WebUI（科技简洁风，参照 DeepSeek Harness Web 观感）

```bash
pnpm build
pnpm mazi config            # 首次先配置（写入 ~/.mazi）

# 两个独立进程（前后端分离）
pnpm run server             # 后端 API：http://127.0.0.1:4317（或 pnpm api）
pnpm web                    # 前端 UI(生产)：http://127.0.0.1:5174（先 pnpm build）
pnpm web:dev                # 前端 UI(开发)：Vite 热更新，/api 自动代理到 4317
# 注意：不要用裸 “pnpm server”——它是 pnpm 内建的 store server 命令，会静默退出；
# 重启前请先结束旧进程（如 lsof -ti:4317,5174 | xargs kill）再 pnpm run server / pnpm web。
```

**apps/web（纯前端静态服务，5174）** 与 **apps/api（纯 API 后端，4317，NestJS + Fastify 模块化实现）** 分离；
页面自动指向后端（默认 http://127.0.0.1:4317，可用 `?api=http://host:port` 覆盖）。

**真实会话流**：输入任务 → [仅创建会话]（`POST /api/sessions`：立即写库 + recording 记录，进入左侧列表）
→ 点击“执行此会话”（`POST /api/sessions/:id/run`）或直接 [创建并运行]；完成后轨迹/事件/指标可见。

三栏 UI（docs/webui.md MVP 子集）：会话列表 / 轨迹对话（thinking/tool_call/observation）/ 审计与事件（三方记录+Usage）/ 底部指标。

- 后端 API：`POST /api/sessions`、`POST /api/sessions/:id/run`、`GET /api/sessions`、`GET /api/sessions/:id`、
  `GET /api/events/<sessionId>[?follow=1]`（SSE）、`POST /api/sessions/:id/feedback`、`GET /api/config|health`、`POST /api/run`（一次性兼容）。
- 存储默认 SQLite（`~/.mazi/mazi.db`）+ JSONL 事件；PostgreSQL/向量为存储 SPI 后续（docs/后端与存储设计.md）。