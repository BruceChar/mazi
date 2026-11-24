# Web Search 工具（web.search）

## 为什么需要

AB 实验室的「调研」任务（如 `调研 2026-2027 适合个人发展的副业`）暴露了一个能力缺口：
两臂都调用了 `blackboard.read` / `ls` 之类的本地工具，工作区为空后就直接凭模型参数作答，
没有任何联网检索。根因不在 loop 模式，而在**工具面里没有检索能力**：

- 内置工具只有 CLI 包装（`fs.read` / `rg` / `fd` / `xh` / `shell.run` …），`xh` 只能请求**已知 URL**；
- 没有「给一个 query，返回候选来源」的入口，模型不会凭空构造搜索 URL；
- `research` prompt pack 要求「关键结论必须附来源」，但没有可用的取源工具，约束落空。

## 设计

`web.search` 是运行时原生工具（`ToolConfig.impl`，不是 CLI 包装），输入 query，返回结构化候选：

| 字段 | 说明 |
|---|---|
| `query` | 必填，检索词 |
| `limit` | 可选，返回条数，1–8，默认 5 |

输出为纯文本列表：`序号 / 标题 / URL / 发布时间（若有） / 摘要`。摘要在 300 字内，
URL 供后续 `xh` 打开原文；Perplexity 这类会返回生成摘要的 provider，摘要放在来源列表之前。

- 权限：`read-only`，副作用 `net`；网关按 `net.fetch` 归类，输出标记为不可信（untrusted output），
  不得把检索结果当作指令执行。
- **检索 provider 与聊天 model provider 完全分离**：`web.search` 只从独立的
  `webSearch` 配置和 provider 注册表选择后端，不根据当前聊天 provider 决定能否检索。
  聊天 provider 从 DeepSeek 换成 OpenAI / Anthropic / 其他，检索照旧走自己的 provider。

### Provider 注册表（DSH 方案）

参考 DSH 的 `ctx.web` seam，而不是 Codex 的「聊天 Responses API 原生 web_search server tool」：
Codex 的 server tool 依赖聊天端点是否接受 `web_search` 工具，换到不支持该工具的 provider
就会 400 或静默失效。DSH 把搜索当成独立 capability seam，provider 自己实现 HTTP 调用，
聊天 provider 不参与。

当前内置：

| id | 类型 | 必需配置 | 说明 |
|---|---|---|---|
| `deepseek` | primary | `DEEPSEEK_SEARCH_API_KEY` 或 `webSearch.deepseek.apiKeyEnv`；缺省可复用 deepseek 聊天 provider 的 Key | Anthropic Messages + `web_search_20250305`，返回结构化来源 |
| `exa` | primary | `EXA_API_KEY` 或 `webSearch.exa.apiKeyEnv` | `POST /search`，highlight 作摘要，`publishedDate` 作时间 |
| `perplexity` | primary | `PERPLEXITY_API_KEY` 或 `webSearch.perplexity.apiKeyEnv` | OpenAI-compatible chat completions；生成答案 + `search_results` / `citations` |
| `bing` | fallback | 无 | Bing HTML 解析，仅在没有任何可用 primary 时兜底 |

选择规则（对齐 DSH 的“不依赖注册顺序”）：

1. `webSearch.provider` 指定了 id：必须已注册且 `available()`，否则明确失败；
2. 未指定：恰好一个 primary 可用 → 用它；
3. 多个 primary 可用 → 报 `multiple web search providers... configure webSearch.provider`；
4. 没有可用 primary → 用唯一 fallback（Bing）；
5. 连 fallback 都关闭/不可用 → `ok:false`。

### 配置

`settings.json` 增加独立的 `webSearch` 段；Key 建议走环境变量，不写进 settings：

```json
{
  "webSearch": {
    "provider": "exa",
    "deepseek": { "model": "deepseek-flash" },
    "exa": { "searchType": "auto" },
    "perplexity": { "model": "sonar" },
    "bing": { "enabled": true }
  }
}
```

- 显式 `"provider": "deepseek"` 时只走 DeepSeek 原生检索，失败直接返回 `ok:false`，不回退 Bing。
- 省略 `provider` 时按上面的唯一 primary 规则；当前只有 DeepSeek Key 的部署会自动用它。
- 没有任何搜索 Key 时自动落到 Bing；`bing.enabled=false` 可关闭这个 HTML 兜底。
- 单次请求 30s 超时；不缓存、不写入磁盘；每次调用都是一次真实网络请求。

## 与 loop 模式的关系

`web.search` 属于工具面（ToolPlane），default / dynamic 两种 loop 都能看到同一个工具。
因此它不改变 loop 对照实验的自变量；A/B 里两臂检索行为应一致，差异仍只来自调度与收敛方式。

## 模型使用规范

`research` prompt pack 增加约束：

- 任务涉及外部事实、市场数据、时效信息时，**先用 `web.search`**，再用 `xh` 打开关键来源；
- 没有检索结果或无法核实时，明确写「未联网核实」，不得编造数字与出处。

## 已知边界

- 结果排序与摘要由所选 provider 决定；运行时不改写，只按 URL 去重并截断。
- `deepseek` 的 native 检索要求 `web_search_tool_result` 块；没有结果块按失败处理，绝不把模型正文当搜索结果。
- Exa / Perplexity 需要各自账号与 Key；没有 Key 时它们只是 unavailable，不影响其他 provider。
- Bing HTML 解析可能因页面结构变化失效；失效时工具返回失败而不是空成功。
- 需要登录/付费的内容仍要 `xh` 或人工提供链接。
