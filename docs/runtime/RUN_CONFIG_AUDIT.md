# RunConfig / RunOptions 审计

审计对象：`packages/runtime/src/harness/conversation.ts` 的 `RunOptions`、`runtime.ts` 的 `RuntimeConfig` 消费路径。结论只涉及设计，改动按第五节分步实施。

## 一、发现的问题

### 1. `maxSteps` 是静态步数，不是任务预算

同一组参数对「改一行文档」和「重构一个模块」的含义完全不同。它既不能表达剩余资源，也不能在运行中修正。真正的控制点是**进度审视**：定时/按步检查已消耗的时间、token、成本与开放项，再决定继续、暂停还是中止。

`maxCostUsd` 同理：只在上限处截断，没有中途审视，等于事后才知道超了。

### 2. `workspaceRoot` 一字段三义

| 语义 | 使用点 |
| --- | --- |
| 进程 cwd | `runShellTool` / `runCliTool` |
| 项目身份 | blackboard `ensure/reconcile`、session 上下文片段 |
| 权限边界 | `assertInsideWorkspace` 包住 fs 写读、effect 快照 |

前两者是上下文，第三条是策略。把「项目根目录」当成「允许访问的边界」，会让工具权限由路径推导，而不是由用户偏好与红线决定：换个目录就换了权限，写死一个路径就永久放开。

### 3. `RunOptions` 混装产品契约与测试接缝

`llmProviders`（离线注入）和 `taskPlanner`（测试/宿主注入）不是产品参数；它们与 `userId` / `permissionCeiling` / `skillIds` 同层，导致：

- 入口签名不断加字段，调用方无法区分「用户能配的」与「只为测试存在的」；
- `taskPlanner` 注入还会**改写产品默认**：`taskPlanningByDefault = taskPlanning === true || taskPlanner !== undefined`，装一个测试 planner 就等于给产品开了规划开关；
- `setTaskPlanner` 内重复 `ports.set('taskPlanner', planner)`（两行同写）。

### 4. 隐式推断与输出当输入

- `taskPlanning` 与 `taskPlanner` 两条入口推导同一件事，行为依赖「谁先被设置」；
- `flagTrace` 是运行产物却被当作输入字段回灌配置；
- `consoleEnabled` / `systemPrompt` 属于逃生门，应标注 internal，不进产品文档。

## 二、目标形态

### `RunRequest`（产品契约）

```ts
interface RunRequest {
    userId?: string;
    projectId?: string;
    projectRoot?: string;              // 仅上下文，不产生权限
    permissionCeiling?: PermissionLevel;
    fsPolicy?: { read: string[]; write: string[]; redlines: string[] };
    budget?: { wallClockMs?: number; tokens?: number; costUsd?: number };
    promptFragment?: string;
    skillIds?: readonly string[];
    allowedTools?: readonly string[];
    disabledModules?: readonly string[];
    modelId?: string;
    reasoningLevel?: string;
}
```

### `RunInjection`（测试与宿主接缝）

```ts
interface RunInjection {
    llmProviders?: Record<string, LLMProvider>;
    taskPlanner?: TaskPlanner;
}
```

内部保持 `type RunOptions = RunRequest & RunInjection`，8 处内部签名零改动；只在 `run()` / `createSession()` 两个入口分开接收，注入项走第二个参数或宿主装配期注入（优先后者）。

### 预算与进度审视

```ts
interface RunBudget { wallClockMs: number; tokens: number; costUsd: number }
interface ProgressSnapshot { elapsedMs: number; tokens: number; costUsd: number; openTasks: number; planVersion: number; noProgressSteps: number }
type Review = 'continue' | 'pause' | 'abort';
interface ProgressAuditor { review(snapshot: ProgressSnapshot): Review }
```

- `maxSteps` 降级为**内部硬保险丝**（默认 50，不进 UI、不进 GoalContract）；
- `maxCostUsd` 改 `budget.costUsd`，由 auditor 在每 N 步或每 M 秒审视；
- 后续可扩展 `escalate`（换更强模型）与 `verify`（强制先验收）。

### 权限

- `projectRoot` 只进上下文与 blackboard，不再参与 `assertInsideWorkspace`；
- 文件工具权限来自 `fsPolicy` + `permissionCeiling`，越界走审批 seam 申请一次性放行；
- `config.goal.{permissionCeiling, allowedTools}` 与 `RunRequest` 双入口收敛为：请求覆盖配置，配置为默认。

## 三、兼容策略

1. 先加新字段、保留旧字段并标注 `@deprecated`；
2. `maxSteps` 读路径改为「若显式给出则当硬保险丝，缺省 50」，UI 不再暴露；
3. `workspaceRoot` 拆出 `projectRoot` 后，`assertInsideWorkspace` 改读 `fsPolicy.write`，旧字段仅作 `projectRoot` 与 `fsPolicy.write=[root]` 的兼容默认；
4. `taskPlanner` 注入不再置 `taskPlanningByDefault`，规划由节点可用性决定（见 `WORKFLOW_NODES.md`）。

## 四、验收口径

- 同一 `RunRequest` 在 `budget` 变化时只影响终止时机，不影响权限；
- `projectRoot` 指向仓库外目录，文件工具权限不因此变化；
- 只传 `RunInjection.taskPlanner` 不改变产品默认行为；
- `RunOptions` 新字段全部落在 `RunRequest` 或 `RunInjection`，不存在第三类。

## 五、实施顺序（未开始）

1. 抽 `RunRequest` / `RunInjection` 类型与入口重载（行为不变，纯类型）；
2. `projectRoot` + `fsPolicy`，`assertInsideWorkspace` 改读策略；
3. `RunBudget` + `ProgressAuditor`，`maxSteps` 降为内部保险丝；
4. 去 `taskPlanningByDefault` 隐式推断，接 `WORKFLOW_NODES.md` 的节点选择；
5. 清理 `flagTrace` 回灌与 `setTaskPlanner` 重复写入。

每一步独立提交，先补测试再改实现。
