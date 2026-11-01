# Agent P0–P3 实施清单

> 目标：让 mazi 既能理解用户，又能理解项目；让 Agent 在长程任务中按需获得最小充分上下文，并以可评测方式持续优化。
>
> 范围：只规划 P0–P3。RL 部分只建设评测、轨迹和奖励数据接口，不在本项目实现 SFT/DPO/GRPO/PPO 等训练器。
>
> **实施状态（2026-11-02）**：P0、P1 与 P2-A/P2-B 已完成基础版并分别提交；P3 尚未开始。

## 1. 设计结论

### 1.1 两条必须同时成立的主线

1. **个人长期记忆**：跨项目沉淀用户偏好、领域知识、历史问题、决策、任务结果与项目关联，帮助新会话理解“这个用户是谁、以前做过什么、为什么做过”。
2. **项目黑板**：项目拥有自己的结构化知识、架构、状态、已完成项、未决项和证据引用，使项目内新会话无需重新扫描全部文件。

二者不能合并成一张无差别记忆表：

| 平面 | 回答的问题 | 生命周期 | 主要使用者 |
| --- | --- | --- | --- |
| 用户记忆 | 用户是谁、偏好什么、关心哪些领域、过去做过哪些项目 | 跨项目、长期 | SuperAgent、Planner、Verifier |
| 项目黑板 | 当前项目是什么、结构如何、做到哪一步、下一步是什么 | 绑定项目版本、持续更新 | SuperAgent、Planner、Executor |
| 会话/任务记忆 | 当前问题如何产生、执行了什么、结果如何 | 会话、任务、Episode | Replan、Verifier、Memory Curator |
| 审计轨迹 | 当时谁授权、系统执行了什么、事实是否被篡改 | 只追加、按治理策略保留 | 审计员、评测器 |

### 1.2 事实优先级

任何记忆中注入的内容都不能覆盖以下事实层级：

1. 当前代码、Git、测试、运行环境和工具真实返回；
2. 当前 GoalContract、权限策略和审批结果；
3. 经验证的审计事件与 Verifier 结果；
4. Project Blackboard；
5. 用户长期记忆与模型摘要；
6. 模型推断。

Project Blackboard 是派生知识和索引，不是源代码、Git 或测试结果的真相源。所有关键结论必须保留证据引用和最后验证时间。

### 1.3 SuperAgent 的定位

SuperAgent 不是拥有额外权限的“超级模型”，而是请求级、用户级编排策略：

```text
请求
  → 识别用户 / 项目 / 话题 / 风险
  → 加载用户常驻记忆 + 项目黑板摘要
  → 匹配最小 PromptPack
  → 选择 Planner / Executor / Verifier / 工具边界
  → 独立验收
  → Memory Curator 提议更新用户记忆和项目黑板
  → 校验、版本化、落库
```

SuperAgent 可以长期存在的是**记忆与策略状态**，不是常驻模型进程。它不能自行扩大权限，所有工具调用仍经过 ToolGateway。

---

## 2. P0：评测、个人记忆与项目黑板底座

P0 是本计划共同依赖。评测体系负责证明记忆和黑板确实提高任务效果，而不是让记忆无限膨胀。

### P0-A 评测 Harness 与任务数据（已实现基础版）

#### 交付

- 新建 `packages/eval`，提供可复用的离线评测执行器。
- 首批建立 **30–50 个任务**；后续扩展到 100+。
- 任务至少分为：simple / medium / hard / long-horizon / memory / security。
- 每个任务包含用户输入、初始环境、允许工具、预期副作用、验收条件、预算和难度。
- 支持 faux/recorded model、真实 model 和固定环境回放。
- 生成机器可读报告 JSON 与人工审阅 Markdown/WebUI。

#### 核心数据类型

```ts
EvalTask {
  taskId
  difficulty: 'simple' | 'medium' | 'hard' | 'long-horizon'
  category: string
  initialEnvironmentRef
  userInput
  allowedTools
  expectedEffects
  acceptance: AcceptanceSpec
  budget
  hiddenChecks
}

EvalRun {
  runId
  taskId
  model, promptPackId, planVersion
  outcome
  metrics
  failureAttribution
  traceRef
}
```

#### 必做指标

- 任务成功率。
- 工具选择准确率。
- 工具参数正确率。
- 多余工具调用率。
- 人工审批、接管和中断率。
- Step、工具调用和 Replan 次数。
- P50/P95 延迟。
- Input/output/cache token。
- 总成本。
- 恢复成功率。
- 安全违规率。
- 记忆 precision / recall / stale injection。
- PromptPack 激活精度和每成功任务 token 成本。

#### 门禁

- 一次命令完成全量离线评测，报告可按模型、PromptPack、任务等级分组。
- 确定性检查优先；语义检查必须标记 judge 版本和校准样本。
- 每个失败能关联到具体 Task/Step/Trace。
- CI 可运行固定 faux 回归集。

### P0-B 个人长期记忆（已实现基础版）

#### 记忆分层

```text
User Resident
  - 身份与称呼
  - 明确偏好
  - 语言、输出风格、代码风格
  - 长期红线

User Domain
  - 熟悉领域、技术栈、长期关注主题
  - 领域事实及其有效期、来源和可信度

User Episode
  - 提过的问题
  - 执行过的任务
  - 最终结果、失败与修复
  - 当时关联的项目

User Relationship
  - 用户 ↔ 项目
  - 问题 ↔ 项目
  - 决策 ↔ 证据
  - 新旧事实的 supersedes / contradicts 关系
```

#### MemoryRecord

```ts
MemoryRecord {
  memoryId
  kind: 'preference' | 'fact' | 'episode' | 'decision' | 'relationship'
  scope: 'user' | 'workspace' | 'project' | 'conversation' | 'task'
  subject: { type, id? }
  content: { text, structured? }
  provenance: {
    source: 'user_explicit' | 'user_confirmed' | 'tool' | 'system' | 'model_inferred'
    ref?
  }
  confidence: 'confirmed' | 'inferred' | 'pending_confirmation'
  trustTier: 'T1' | 'T2' | 'T3'
  validFrom?, validTo?, expiresAt?
  status: 'active' | 'deprecated' | 'tombstoned'
  links: { projectIds?, topicIds?, sessionIds?, taskIds?, entityIds? }
  importance
  contentHash
  embeddingRef?
  version
}
```

#### 写入策略

- 用户明确陈述的偏好可直接写为 confirmed。
- 模型推断的偏好默认 `pending_confirmation`，不得长期静默生效。
- 工具结果和任务结果只能生成 Episode/Fact 候选，必须经 harness 校验后落库。
- 用户最新明确偏好覆盖旧推断；冲突历史保留，不就地改写。
- 不保存模型隐藏 chain-of-thought；保存结构化决策摘要、证据引用和结果。
- 授权与审批作为审计事实独立保存，不混入语义回忆。

#### 召回策略

召回分数由多路组成：

```text
score =
  semantic_relevance
  + fts_match
  + entity_link
  + project_affinity
  + explicit_reference
  + importance
  + recency_decay
  - stale_penalty
  - conflict_penalty
```

- 稳定偏好与环境事实采用较弱时间衰减。
- Episode 采用较强时间衰减，但“长期未提但被明确关联”时仍可召回。
- 召回预算分层：resident ≤300 tokens，动态召回 ≤500 tokens，其余以指针形式提供。
- 注入项需要信任等级、来源、时间和指针；不能只拼一段无来源摘要。

#### 跨会话关联

当用户说“上次那个迁移项目”“之前那个问题”时：

1. 从问题中抽取实体和任务类型。
2. 在用户的项目/话题索引中做混合检索。
3. 召回候选项目黑板摘要和历史 Episode。
4. 以低置信度提供“你可能在说 X”，必要时向用户确认。
5. 确认后建立显式 relation，提升后续召回。

#### 用户控制

必须支持查看、纠正、暂停、删除、导出和查看 provenance。删除产生 tombstone，阻止从残留摘要重新学习。

#### 门禁

- 跨项目偏好能被召回，且不会串入其他用户数据。
- 30 天后的“以前那个项目/问题”能召回正确项目或明确要求确认。
- 旧推断被用户新声明覆盖后，旧值不再注入。
- 已删除记忆不会再被召回。
- 记忆召回报告能解释“为什么召回、来自哪里、何时有效”。

### P0-C Project Blackboard（已实现基础版）

#### 黑板内容

```ts
ProjectBlackboard {
  projectId
  workspaceRef
  name
  purpose
  status
  architectureSummary
  stack
  coreModules
  interfaces
  constraints
  activeGoals
  completedMilestones
  knownIssues
  decisions
  nextActions
  recentChanges
  evidenceRefs
  lastVerifiedAt
  sourceFingerprint
  version
}
```

项目黑板不是仓库全文摘要，而是“开始工作所需的最小充分项目状态”。

#### 更新路径

```text
工具写操作 / Git 状态 / 测试结果 / Task Outcome / 用户明确决策
  → deterministic capture
  → blackboard delta proposal
  → evidence + stale checks
  → schema validation
  → versioned append
  → project.blackboard.updated event
```

模型可以提出 delta，但不能直接覆盖黑板。确定性捕获与版本化提交由 harness 完成。

#### 新会话注入

新会话默认按三层注入：

1. **Board Resident**：项目目的、状态、架构、约束，约 300–700 tokens。
2. **Board Index**：模块、接口、决策、未决项名称索引，约 100–200 tokens。
3. **On-demand Detail**：模型通过 `blackboard.read(section)` 获取完整章节和证据。

只有在黑板缺失或 `sourceFingerprint` 明显过期时才触发项目扫描；正常新会话不读取完整仓库。

#### 新鲜度

- 使用 Git HEAD、关键文件哈希、测试时间和最近事件生成 `sourceFingerprint`。
- 黑板章节标记 `verifiedAt / invalidatedAt`。
- 代码变更后只标记受影响章节 stale，不强制全量重建。
- 对目标/完成状态等关键字段，优先引用 GoalStore、测试和 Git 证据。

#### 门禁

- 新项目会话在无全仓扫描的情况下能回答“项目是什么、做到哪、下一步是什么”。
- 黑板摘要能定位到章节证据，不把摘要当事实。
- 代码或测试状态变化后，受影响章节被标记并重验证。
- 项目 A 的黑板不得进入项目 B 的上下文。
- 删除/迁移项目时黑板、索引和关系均按策略处理。

---

## 3. P1：SuperAgent、最小适配 Prompt 与独立 Verifier（已实现基础版）

### P1-A SuperAgent（已实现基础版）

#### 职责

- 用户与项目识别。
- 选择常驻记忆和项目黑板切片。
- 选择 PromptPack、Planner、Executor、Verifier 和能力。
- 处理跨项目关联与会话恢复。
- 在任务结束后触发 Memory Curator 和 Blackboard Curator。
- 仅负责编排，不获得额外权限。

#### 运行边界

```ts
SuperAgentDecision {
  userId
  projectId?
  topicIds
  taskKind
  risk
  promptPackId
  plannerId
  verifierId
  memoryPlan
  blackboardPlan
  reason
}
```

决策必须落事件并记录依据；不得只在模型隐藏推理中存在。

### P1-B PromptPack：最小适配 Prompt（已实现基础版）

#### 原则

不是所有项目共享一个巨型 Prompt，也不是所有项目各维护一套完全不同的 Prompt。采用分层、版本化、可匹配的 PromptPack：

```text
L0 Core Invariants
  所有 Agent 永远生效的最小安全与行为约束

L1 Capability Index
  PromptPack / Skill / Tool 的名称、适用条件、预算

L2 Matched Modules
  仅加载当前任务匹配的模块正文

L3 Evidence / Examples
  按需加载项目约定、参考实现、领域示例
```

这与 Skill 的渐进式披露一致：先索引，再正文，最后资源。

#### PromptPack Schema

```ts
PromptPack {
  id
  version
  priority
  matcher: {
    projectTags?
    taskKinds?
    filePatterns?
    toolNeeds?
    riskLevels?
    explicitProjectPack?
  }
  layers: {
    module: string
    examples?: string[]
    projectRules?: string[]
  }
  budgetTokens
  conflictsWith
  evalBaselineRef
}
```

#### 匹配流程

1. 显式项目配置或用户指定。
2. 结构化信号：项目标签、任务类型、文件模式、工具需求、风险。
3. 语义匹配仅作为补充。
4. 低于阈值不注入。
5. 多个 Pack 冲突时 Core > 项目明确规则 > 任务 Pack > 语义匹配。
6. 总 token 超预算时按“提升成功率的边际收益”裁剪。

#### 稳定前缀与缓存

- L0 + User Resident + 稳定 Project Profile 构成 prefix。
- PromptPack 在 Task/Session 边界冻结并写入 prefix hash。
- PromptPack 切换形成新 epoch。
- 动态记忆和检索结果进入尾部，不频繁重写前缀。

#### 评测

- PromptPack 激活 precision / recall。
- 同等成功率下 token 和成本下降。
- 不匹配时的漏加载率。
- 冲突导致的任务失败率。
- Cache hit 与 per-success token cost。

### P1-C 独立 Verifier（已实现基础版）

Verifier 是与 Executor 分离的角色：

- 读取 GoalContract、TaskOutcome、证据和工具观察。
- 输出 `pass | fail | uncertain`、逐条款结果、失败类型和置信度。
- 确定性条件由代码判；语义条件可调用校准后的 LLM Judge。
- Verifier 不能修改 Plan、不能调用高权限工具、不能自批。
- 不确定结果进入人工确认或保守停止。

### P1-D 失败归因（已实现基础版）

统一分类：

```text
model | planning | tool_selection | tool_execution |
context | memory | policy | environment | system
```

归因结果需要关联 Step/Trace 证据，并区分“观测事实”和“推测原因”。

### P1 门禁

- 同一请求在不同项目选择不同 PromptPack，并记录选择依据。
- PromptPack 减少 Prompt token 且离线成功率不下降。
- Verifier 与 Executor 模型分离；语义 Judge 有校准集。
- 失败可以区分模型、规划、工具、上下文和系统原因。
- SuperAgent 不能通过选择 PromptPack 绕过权限或预算。

---

## 4. P2：动态 Replan 与多 Agent（已实现基础版）

### P2-A 动态 Replan（已实现基础版）

```text
Observe
  → Verifier
  → failure attribution
  → replan decision
  → bounded plan revision
  → execute affected tasks
```

规则：

- 契约和目标不可被 Replan 偷偷改写。
- 限制最大 Replan 次数和总预算。
- 已完成 Task 默认复用。
- Plan diff、触发证据和原因必须落审计。
- 检测计划漂移、循环调用和上下文污染。

### P2-B 多 Agent 与 Handoff（已实现基础版）

实现已有 [多 Agent 设计](./AHF_RUNTIME_MULTI_AGENT.md)：

- AgentRole 注册表。
- delegation edge 存储。
- 父子权限和预算单调递减。
- 并行扇出与失败隔离。
- `delegate` 工具与 handoff。
- Role 级模型、工具、PromptPack 和记忆策略。
- 委托树投影、恢复和审计。

### P2 门禁

- Verifier 失败能触发有限、可审计的 Replan。
- Replan 后成功率和成本可与 baseline 对比。
- 一个子 Agent 失败不影响无关兄弟。
- 子 Agent 不能越权或超预算。
- 新进程能恢复多 Agent 委托树和已完成 Task。

---

## 5. P3：MCP 与 RL-ready 评测支持

本项目只实现 RL 所需的 runtime、数据、奖励和评估接口，不实现 PPO/GRPO 等训练器。

### P3-A MCP Adapter

- MCP `list_tools` 动态发现。
- MCP schema 转 ToolRegistry schema。
- 连接、重连、注销、版本固定。
- 外部工具默认 full-trust / gated。
- MCP 输出标记 untrusted。
- MCP 描述文本做注入审查。

### P3-B RL-ready Trajectory

```ts
AgentTrajectory {
  trajectoryId
  userId, projectId, sessionId
  taskSpec
  contextSnapshot
  promptPackId
  planVersions
  steps[]
  verifierResults
  humanLabels
  cost, latency
  finalReward
  failureAttribution
}
```

### P3-C 奖励与数据集评估

- 规则奖励。
- 确定性 Verifier 奖励。
- 人工偏好奖励。
- Reward Model / LLM Judge 适配接口。
- Rejection Sampling 候选筛选。
- SFT / DPO / GRPO 数据导出。
- Trainer 外部接口与 mock trainer。
- 训练前后使用同一 Eval Harness 对比。
- Reward Hacking 检测：绕过测试、伪造结果、少执行步骤、过度调用、记忆污染。

### P3 门禁

- MCP 工具经过统一 ToolGateway，不存在第二执行点。
- 从真实运行导出的轨迹可以离线回放。
- 奖励结果可追溯到具体 Verifier/人工标签。
- 数据可导出为 SFT/DPO/GRPO 所需格式。
- 训练器可以替换，但评估集和指标口径不变。
- 不要求在本仓库内执行任何模型训练。

---

## 6. 推荐实施顺序

### 里程碑 M0：先证明底座

1. P0-A Eval Task + Metrics。
2. P0-B 个人记忆 schema、SQLite/FTS、显式偏好和跨会话召回。
3. P0-C Project Blackboard schema、增量更新和新会话注入。

### 里程碑 M1：最小可用 SuperAgent

1. 用户/项目识别。
2. 最小 PromptPack 匹配。
3. 独立 Verifier。
4. 失败归因。

### 里程碑 M2：长程执行增强

1. 动态 Replan。
2. 多 Agent 角色、委托和 handoff。
3. 项目黑板与委托树联合恢复。

### 里程碑 M3：生态与优化

1. MCP adapter。
2. Trajectory 导出与回放。
3. 奖励评估、数据导出和 trainer seam。

## 7. 总体 Definition of Done

1. 用户偏好可跨项目复用，敏感数据按作用域隔离。
2. 数周后重新提及旧问题，可关联正确项目并展示证据。
3. 项目新会话无需全仓扫描即可恢复最新项目知识。
4. 不同项目自动使用不同最小 PromptPack，并有 token/成功率对照。
5. SuperAgent 只编排，不越权。
6. Verifier 独立于 Executor，失败能归因并驱动有限 Replan。
7. 多 Agent 委托可审计、可恢复、权限和预算单调递减。
8. MCP 工具统一经过 ToolGateway。
9. Trajectory 可回放并导出为 SFT/DPO/GRPO 数据。
10. 所有优化均通过统一 Eval Harness 回归；不在本仓库实现训练器。
