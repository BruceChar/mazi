---
name: project-wiki
description: 项目知识库(wiki/)的读写与维护协议。检索项目背景、确认事实、
  记录新知识、更新任务状态或校验 claims 时使用。启用后按本文件执行，
  不要调用旧版 wiki.read/wiki.update。
---
# 项目 Wiki 协议

wiki/ 是本项目对 agent 的唯一事实库。三条铁律：

1. 动手前先查 wiki，不推测项目约定
2. 会话中学到 durable 事实，当场写入（写入即自动 commit，无需手动提交）
3. 代码改动使已记录事实漂移 → 满足内容一致性（同 commit 或 wiki 先行均可）

## 前置条件

- 项目已完成初始化（wiki/ 目录存在）。未初始化时执行：
  python3 "{skill-dir}/scripts/wiki.py" init
- `{skill-dir}` 指本 SKILL.md 所在目录，具体路径见 AGENTS.md 的指针。

## 首次初始化与 overview

`init` 只生成确定性骨架，不根据 README 编写架构结论。若 INDEX 仍是 TODO 或
claims 为空，按以下顺序完成首次冷启动：

1. 读取 `README.md`、包/工作区清单（`package.json`、`pnpm-workspace.yaml`、
   `pyproject.toml`、`go.work` 等）以及现有 `AGENTS.md`/`AGENT.md`。
2. 只针对关键入口、公共包和跨模块边界补充读取源码或文档。
3. 填写 `wiki/overview/architecture.md`：模块职责、关键数据流、依赖关系；
   填写 `conventions.md` 中的真实约定与红线；核对 `commands.md` 的提取命令。
4. 更新 `wiki/INDEX.md` 的一句话定位、模块地图和确认过的红线；
   更新 `wiki/state/current.md` 的进行中事项、阻塞与下一步。
5. 为核心机制建立首批 claims，evidence 必须指向真实文件；
   不把函数签名、单文件细节或 README 宣传语写成事实。
6. 执行 `checkpoint`，让冷启动结果成为下次会话的起点。

无法从项目内容确认的信息保留 TODO，不推测。

## 会话生命周期

- SessionStart：读 wiki/INDEX.md 建立基础认知（若 hook 注入了 doctor
  --git-status 报告，先扫一眼哪些事实可能 stale）
- 任务完成：代码 commit 前，同步更新受影响的 claims
- SessionEnd / 任务收尾：执行 python3 "{skill-dir}/scripts/wiki.py" checkpoint
  （或调用 wiki_checkpoint tool，若本环境已注册）

## 读取（渐进式，禁止整库通读）

1. 需要细节：grep -rni --include="*.md" -e "<关键词>" wiki/overview wiki/state
2. 命中后 cat 文件
3. 质疑某条事实：grep "{claim-id}" wiki/claims.toml，
   然后 python3 "{skill-dir}/scripts/wiki.py" doctor --claim "{claim-id}"
   单点校验（毫秒级，不要全量 doctor）

## 写入

新增事实：
  python3 "{skill-dir}/scripts/wiki.py" claim add --id "{claim-id}" \
    --text "{一句话事实}" --ev "{文件}" [--ev ...]
  同时把可读版本写进对应 overview/ 或 state/ 文档

事实漂移（doctor 报 stale/missing，或本次改动涉及某 claim 的 evidence）：

1. python3 "{skill-dir}/scripts/wiki.py" update --plan 拿清单
2. 逐条重读源文件 → verify / update / retract 三选一
3. 满足内容一致性铁律后提交代码

## 命令速查

| 场景                           | 命令                                         |
| ------------------------------ | -------------------------------------------- |
| 新增事实                       | claim add --id X --text "..." --ev 文件      |
| 事实仍成立（代码变了语义没变） | claim verify --id X                          |
| 事实部分变化                   | claim update --id X --text "新表述" --ev ... |
| 事实失效                       | claim retract --id X --reason "..."          |
| 会话启动初筛                   | doctor --git-status                          |
| 单点核验                       | doctor --claim X                             |
| 全量体检                       | doctor（或 doctor --all 递归所有嵌套 root）  |
| 漂移清单                       | update --plan                                |
| 会话收尾                       | checkpoint                                   |

## 红线

- 代码能自述的不写；只写事实/规则/指针，不写叙述散文
- claims.toml 禁止手改，oid 一律由脚本计算
- 绝不自动 commit 用户的代码改动，wiki.py 只提交 wiki/ 路径
- 单个 wiki 文档 >150 行必须拆分

## 排错

- 提示"未检测到 git" → python3 "{skill-dir}/scripts/wiki.py" setup-env
- 提示"未找到 wiki root" → 回到项目根执行，或先 init
- checkpoint 被拒 → 存在未修复漂移，先跑 update --plan 流程；
  确认要带漂移打点时加 --force（不推荐）
