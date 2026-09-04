# mazi 用户目录配置、模型动态发现与 WebUI 设计

> **版本**：v0.1
> **动机**：① 配置/存储不应落在项目路径，应位于用户目录；② 预设模型 id 会过时，需从厂商 API 动态获取最新模型；③ 提供科技简洁风格的 WebUI（参照 DeepSeek Harness Web 观感）作为除 CLI 外的第二入口。

---

## 1. 用户目录布局（~/.mazi）

```
~/.mazi/
├── providers.json        # provider 配置（CLI 默认 config 根）
├── tools.json            # 工具白名单
├── flags.json            # Flag 覆盖（可选）
├── mazi.db               # SQLite（session/turn/step/user_interactions）
└── events/               # 事件 JSONL（<sessionId>.jsonl，审计不可丢）
```

- 根目录可用 **`MAZI_HOME`** 环境变量覆盖（缺省 `os.homedir() + '/.mazi'`）。
- 语义：**config 根 == MAZI_HOME**（json 平铺于根，存储在其子目录/文件）。`--config-dir`/存量 `apps/cli/config` 仍可显式指定以兼容项目内 demo。
- 默认值（未显式传参时）：`config-dir = MAZI_HOME`、`db = MAZI_HOME/mazi.db`、`event-dir = MAZI_HOME/events`；首次使用自动 mkdir。
- 实现位置：`packages/harness-runtime/src/paths.ts`（唯一来源），CLI 与 WebUI 共用。

## 2. 模型动态发现（wizard 不再用硬编码旧模型）

- 依据 pi-ai（@earendil-works/pi-ai 0.85）：`builtinModels()` 静态目录已含较新模型；部分厂商（openai 等）支持 `Models.refresh()` 从远端目录拉取。
- 流程（`mazi config`）：
  1. provider 有可用 key（默认 env 命中）→ `await models.refresh({ providers: [id] })` 拉取最新；
  2. 候选 = `models.getModels(id)`（已刷新）或静态目录（未配置 key/拉取失败时回退，并提示“使用本地目录，可能非最新”）；
  3. 过滤仅支持工具调用的模型（pi-ai 目录语义），按列表让用户挑选（序号），无选择回退默认；可手输任意 id。
- 移除 preset 中对模型 id 的强依赖：preset 仅提供 provider 元信息（label/默认 env/pricing 缺省值）。

## 3. WebUI（apps/web）

- **零新增依赖**：node:http + 静态 HTML/CSS/JS；复用 `@mazi/harness-runtime`。
- 服务：`node apps/web/dist/server.js`，端口 `MAZI_WEB_PORT`（默认 4317），`MAZI_HOME` 决定数据目录。
- REST：
  - `GET /`：页面
  - `POST /api/run`：`{ input, userId? }` → 执行并返回 `{ sessionId, outcome, summary, metrics }`
  - `GET /api/events/<sessionId>`：事件流回放（replay JSONL）
  - `GET /api/runs`：最近用户记录（rawInput/outcome/时间/成本，limit 可调）
  - `GET /api/config`：当前默认目录与 provider id 概览
- 前端：单页深色“科技简洁”风格（类 DeepSeek Harness Web：monospace、低饱和深底、青色强调、细边框、左右分栏：任务输入/结果卡 + 事件时间线/近期运行列表）。
- 线程模型：单进程单 runtime 实例（复用默认 `~/.mazi` 配置）；`run` 串行执行（MVP），并发任务在事件层面天然隔离（sessionId）。

## 4. 验收

| #  | 验收                                                                           |
| -- | ------------------------------------------------------------------------------ |
| U1 | CLI/Web 默认使用`~/.mazi`（`MAZI_HOME` 可覆盖），不再写项目 `config/`    |
| U2 | 自动建目录；db 与事件落于 home 下                                              |
| U3 | `mazi config` 在无 key 时用本地目录回退并可提示；有 key 时拉取最新模型供选择 |
| U4 | WebUI 可完成 run + 结果 + 事件查看 + 近期运行列表                              |
| U5 | 全量测试保持绿（无外部依赖，模型发现/WebUI 网络路径为 manual/可选验证）        |
