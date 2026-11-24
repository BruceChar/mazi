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

输出为纯文本列表：`序号 / 标题 / URL / 发布时间（若有） / 摘要`。摘要在 300 字内，URL 供后续 `xh` 打开原文。

- 权限：`read-only`，副作用 `net`；网关按 `net.fetch` 归类，输出标记为不可信（untrusted output），
  不得把检索结果当作指令执行。
- 后端：优先走 DSH 同款 **DeepSeek 原生检索**（Anthropic Messages 的
  `web_search_20250305` server tool）。请求只取检索结果块，不把模型正文当检索结果；
  `web_search_result` 的 `title/url/snippet/page_age` 直接映射为候选来源，citation 只作为
  snippet 缺失时的补充。模型与 endpoint 取当前 `deepseek` provider 配置；API Key 由
  `secrets.json` 注入的 `driver.apiKey` 提供，工具不读取明文。
- 只有在没有 DeepSeek Key 时才降级到 Bing HTML 解析。DeepSeek 已配置但请求失败时不静默
  回退到 Bing，直接返回 `ok:false`，避免把错误检索结果继续喂给模型。
- 单次请求 30s 超时；不缓存、不写入磁盘；每次调用都是一次真实网络请求。

## 与 loop 模式的关系

`web.search` 属于工具面（ToolPlane），default / dynamic 两种 loop 都能看到同一个工具。
因此它不改变 loop 对照实验的自变量；A/B 里两臂检索行为应一致，差异仍只来自调度与收敛方式。

## 模型使用规范

`research` prompt pack 增加约束：

- 任务涉及外部事实、市场数据、时效信息时，**先用 `web.search`**，再用 `xh` 打开关键来源；
- 没有检索结果或无法核实时，明确写「未联网核实」，不得编造数字与出处。

## 已知边界

- DeepSeek 原生检索结果由厂商返回，排序与摘要由厂商决定；运行时不改写，只按 URL 去重并截断。
- 没有 Key 时的 Bing HTML 降级仍可能因页面结构变化失效；失效时工具返回失败而不是空成功。
- 需要登录/付费的内容仍要 `xh` 或人工提供链接。
