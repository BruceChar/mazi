# AB 测试（对照实验）与 Feature 开关设计

> 版本：v1.0 · 状态：设计定稿（待评审）
> 范围：`packages/core`（Feature / Experiment 契约、观测事件）、`packages/runtime`（FeatureRuntime、ExperimentStore、ExperimentRunner）、`apps/api`（REST）、`apps/webui`（Feature 设置页 + 实验台）、`packages/libs`（文本 diff）。
> 依据：README §13 Roadmap「AB测试：通过flag开关，测试feature的增益」；AGENT.md「文档优先 + 测试先行 + 原子提交」；`docs/能力包规范.md`（Skill 边界）。

---

## 1. 需求

一句话：**给 harness 一个「对照实验台」——同一输入、同一工作区，只改一个自变量（Feature 开关 / Skill 集合 / 模型 / 权限 / 推理档），分 A/B 两臂各跑一次 Goal，并排看最终输出与 Trace，结果写入独立实验日志，可随时复盘。**

用户画像（原话转译）：

1. 执行 AB test 时可以选择一个 feature、一个 skill，或两个不同模型；
2. 同一个输入在「两个窗口」里分别跑；
3. 能看最终输出对比、Trace 面板对比；
4. AB test 有单独的存储日志，可以复盘查看。

### 1.1 为什么不是「再做一个 chat」

普通会话是「用户与模型的一次交互」。实验是**方法论容器**：它回答的是「差异由哪个自变量带来」。因此实验的产物不是回答，而是**可复现的对照记录**：输入、自变量取值、两臂的实际配置、指标、输出、Trace 指针、结论备注。

### 1.2 与现有能力的关系

| 现有能力 | 在实验中的角色 | 变更方式 |
| --- | --- | --- |
| Skill（`SKILL.md`） | 自变量：本次运行挂载哪些 Skill | 新增 `RunOptions.skillIds`（按运行覆盖，不改全局挂载状态） |
| 模型目录 / Provider | 自变量：两臂可指定不同 `modelId` | 复用 `RunOptions.modelId` |
| 权限档位 | 自变量：两臂可指定不同 `permissionCeiling` | 复用 `RunOptions.permissionCeiling` |
| 推理强度 | 自变量：两臂可指定不同 `reasoningLevel` | 复用 `RunOptions.reasoningLevel` |
| **Feature 开关** | 自变量：开关的实际增益（Roadmap 原文） | **新增**（见 §3） |
| Goal / Task / Step + 事件 JSONL | 事实来源：指标与 Trace 全部从既有存储投影，不新增真相源 | 只读复用 |
| 事件总线 | 运行边界审计（`flag.evaluated` / `capability.activated`） | 复用闭集事件 + 新增 1 个 kind |

---

## 2. 概念模型

```
Experiment（实验，一次对照）
  ├── input / workspace          同一输入、同一工作区（控制变量）
  ├── variables[]                自变量声明（kind + baseline + treatment）
  ├── Arm A（基线）  spec → Run(rootGoalId) → Metrics + Trace
  ├── Arm B（处理）  spec → Run(rootGoalId) → Metrics + Trace
  └── Comparison                 确定性指标差 + 输出 diff + Trace 对照 + 复盘备注
```

**执行单位是 Goal Run，不是 Session 续聊**：实验的两臂互不共享上下文（否则 A 的输出会污染 B，自变量不干净）。因此实验不写 Conversation（不进入聊天历史），只写 Goal 存储与实验日志；两臂的 `rootGoalId` 是 Trace 的入口。

### 2.1 控制变量法则

> 一次实验只改 `variables[]` 声明的内容；未声明的运行参数两臂必须完全一致。

实现上由 `ExperimentRunner` 保证：两臂的 `RunOptions` 都以同一份「基线选项 + 该臂 delta」构造，基线选项来自实验定义（workspace / permissionCeiling / reasoningLevel / 挂载技能快照），而不是各自从当前全局状态重新读取——避免实验中途改设置造成两臂不同条件。

---

## 3. Feature（特性开关）

### 3.1 定位

Feature 是**用户可编辑的、声明式的运行配置开关**：打开后只做三件事——追加系统提示片段、调整 Skill 目录集合、**收窄**工具白名单。

与 Skill 的边界：

| 维度 | Skill | Feature |
| --- | --- | --- |
| 形态 | 一个目录 + `SKILL.md`（文本资产） | `features.json` 里的一条声明（开关） |
| 语义 | 「模型判断相关时读这份指导」 | 「这次运行开/不开这项增强」 |
| 可测量性 | 挂载与否是状态 | 开/关是自变量的两个取值，天然适合 A/B |
| 能否新增能力 | 不能（不注册工具） | 不能（只收窄工具面、只改提示与目录） |

判定标准沿用 README §3 的删除测试：删除 Feature 会断掉「flag 增益可测」这一 Roadmap 承诺，故保留；但**它不得成为权限面**：Feature 不能放宽 `allowedTools`，不能改 `permissionCeiling`，不能注册工具。

### 3.2 契约（`packages/core/src/features.ts`）

```ts
export interface FeatureDefinition {
    id: string;                 // kebab-case，唯一
    name: string;
    description: string;
    enabled: boolean;           // 默认开关（可被运行期 override 覆盖）
    promptFragment?: string;    // 开启后追加到系统提示
    skills?: string[];          // 开启后参与/限定的技能 id
    skillMode?: 'add' | 'only'; // add（默认，追加）| only（仅这些）
    allowedTools?: string[];    // 开启后收窄工具白名单（与配置取交集，永不放宽）
    reasoningLevel?: string;    // 开启后作为默认推理强度（显式参数优先）
    createdAt: number;
    updatedAt: number;
}
```

纯函数 `resolveFeatures(defs, overrides)` → `EffectiveFeatures`：

```ts
export interface EffectiveFeatures {
    values: Record<string, boolean>;      // 每次运行的有效开关
    trace: { id: string; enabled: boolean; source: 'default' | 'override' }[];
    promptFragment: string;               // 各开启特性片段以空行拼接
    skillIds: string[];                   // add: 追加；only: 独占
    skillMode: 'add' | 'only' | 'inherit';
    allowedTools?: string[];              // 多特性取交集；无限制则 undefined
    reasoningLevel?: string;              // 多特性取第一个声明
}
```

**不变量（全部由测试固化）**：

- F-1：`overrides` 中不存在的特性按 `enabled` 求值；`trace.source` 如实标注来源；
- F-2：`allowedTools` 是所有开启特性的交集，且调用方必须再与配置白名单取交集——Feature 只能收窄；
- F-3：`skillMode: 'only'` 一旦出现，本次运行的技能集合完全由开启特性决定（不再叠加全局挂载）；
- F-4：`resolveFeatures` 是纯函数，不读文件、不写时间。

### 3.3 存储与生命周期

```
定义：$MAZI_HOME/features.json（{ "features": FeatureDefinition[] }）
发现 → 编辑（新建/改开关/删除）→ 运行期解析（全局默认 + 本次 run override）→ flag.evaluated 事件留痕
```

- 同名 id 不可重复；非法 id（非 kebab-case）拒绝写入；
- 文件损坏 → 视为空集合并告警（不阻断运行）；
- Feature 定义是**用户资产**，不进代码仓库（与 Skill 同规则）；
- `features.json` 与已废弃的旧执行模型 `flags.json` **无关**（旧文件不再读取，路径不同）。

---

## 4. 运行时接入（HarnessRuntime）

新增按运行覆盖，缺省保持原行为（加法变更，向后兼容）：

```ts
export interface RunOptions {
    // ...既有字段
    /** 系统提示追加片段（Feature 解析结果） */
    promptFragment?: string;
    /** 本次运行的技能集合（显式给出则覆盖全局挂载） */
    skillIds?: readonly string[];
    /** 本次运行的工具白名单收窄（与配置白名单取交集） */
    allowedTools?: readonly string[];
}
```

`HarnessRuntime` 在 `createGoalSession` 时按 `rootGoalId` 暂存，`executeGoalTree` 时消费：

1. **系统提示**：`systemPromptWithSkills` 追加 `promptFragment`；
2. **技能目录**：`skillProvider.catalog(context)` 结果按 `skillIds` 过滤（`SkillProvider` 新增 `catalogFor(ids, context)`，缺省实现回退到 `catalog` 过滤，保证测试替身不受影响）；
3. **工具面**：`goalExecutionConfig` 的 `names` 与 `allowedTools` 取交集；
4. **审计**：运行边界发 `flag.evaluated`，attributes 携 `harness.flag_overrides` 与 `harness.skill_id` 同级的 `harness.feature_ids`，payload 携 `trace`——**「这次运行带了哪些开关」可回放**。

> 关闭 feature 等于不追加片段、不调整技能/工具，与改动前完全一致；因此 Feature 系统的引入不改变任何既有会话的行为。
>
> **普通会话按全局默认开关运行，实验台用运行期 override 覆盖单个臂**；两条路径共用同一解析函数 `resolveFeatures`（只是 override 来源不同），因此「实验里测出来的增益」与「开关打开后普通对话的真实行为」是同一份代码。

---

## 5. Experiment 契约（`packages/core/src/experiment.ts`）

```ts
export type ExperimentVariableKind = 'feature' | 'skill' | 'model' | 'permission' | 'reasoning';

export interface ExperimentArmSpec {
    label: string;                       // 'A' | 'B'（一次实验固定两臂）
    modelId?: string;
    skills?: string[];                    // 该臂独占的技能集合
    features?: Record<string, boolean>;   // 该臂的开关取值
    permissionCeiling?: PermissionLevel;
    reasoningLevel?: string;
}

export interface ExperimentVariable {
    kind: ExperimentVariableKind;
    label: string;
    baseline: unknown;                    // A 臂取值（展示用）
    treatment: unknown;                   // B 臂取值
}

export interface ExperimentMetrics {
    ok: boolean;
    status: 'succeeded' | 'failed' | 'aborted';
    tasks: number; steps: number; toolCalls: number; modelRounds: number;
    inputTokens: number; outputTokens: number; cachedInputTokens: number;
    costUsd: number; durationMs: number; ttftMs: number;
    finalAnswer: string; finalAnswerChars: number;
    models: string[];                     // 实际观测到的模型（去重）
    skills: string[]; features: Record<string, boolean>;
}

export interface ExperimentView {
    experimentId: string; title: string; hypothesis?: string;
    input: string; workspace?: string;
    baseline: BaselineOptions;            // 控制变量
    variables: ExperimentVariable[];
    arms: ExperimentArmState[];           // 两臂（含 rootGoalId / metrics / status）
    status: 'created' | 'running' | 'completed' | 'failed' | 'aborted';
    createdAt: number; startedAt?: number; endedAt?: number;
    comparison?: ExperimentComparison;
    reviews: ExperimentReview[];          // 复盘备注（append-only）
}
```

对比结果由纯函数 `compareArms(a: ExperimentMetrics, b: ExperimentMetrics)` 产出，**只做确定性比较**：

| 指标 | 单位 | 优劣方向 |
| --- | --- | --- |
| `ok`（结局） | 布尔 | 成功更优 |
| `costUsd` | 美元 | 低更优 |
| `inputTokens` / `outputTokens` | token | 低更优 |
| `steps` / `toolCalls` / `modelRounds` | 次 | 低更优 |
| `durationMs` / `ttftMs` | 毫秒 | 低更优 |
| `finalAnswerChars` | 字符 | 仅展示，不判优劣 |
| 文本相似度 | 0–1 | 仅展示 |

**不做 LLM-as-judge**：README §6.1 的纪律是「能用确定性代码判断的绝不交给 LLM judge」。本期对比栏只回答「差多少」，不回答「谁更好看」；语义优劣由人在复盘备注里写。LLM 评价器作为后续独立特性（需校准样本），不在本期。

---

## 6. 存储：独立实验日志

```
$MAZI_HOME/experiments/<experimentId>.jsonl     # append-only，一次实验一个文件
```

事件（闭集）：

| type | 何时 | payload |
| --- | --- | --- |
| `experiment.created` | 定义实验 | 完整 spec（input/workspace/baseline/variables/arms） |
| `experiment.started` | 开始执行 | — |
| `arm.started` | 某臂 Goal 创建后 | `{ label, rootGoalId, spec }`（rootGoalId 是 Trace 指针） |
| `arm.ended` | 某臂执行结束 | `{ label, status, metrics, error? }` |
| `experiment.completed` | 两臂结束 | `{ comparison }` |
| `experiment.failed` | 整体失败（如锁冲突/创建失败） | `{ error, failedArm }` |
| `experiment.reviewed` | 人工复盘 | `{ note, verdict: 'A'|'B'|'tie'|'inconclusive', at }` |

- **单一真相源**：实验状态完全由日志折叠（`foldExperiment(events)`）得出，不维护索引文件；`list()` 扫描目录逐文件折叠，本地单用户规模下成本可忽略。
- **与 harness 事件日志分离**：`events/<rootGoalId>.jsonl` 记录「模型看到了什么、harness 做了什么」；`experiments/<id>.jsonl` 记录「实验设计、自变量、指标、结论」。两者以 `rootGoalId` 互相引用，回放时拼接，不复制事实。
- **删除**：`DELETE /api/experiments/:id` 物理删除该实验日志（实验是方法记录，不是审计事实；级联不删除 Goal 存储，Trace 仍可按 rootGoalId 查看）。
- **不设 update 事件**：复盘备注是 append-only 的 `reviewed` 事件；不提供改写历史实验的接口。

---

## 7. 执行器语义（ExperimentRunner）

```
定义 → experiment.created
   ↓
experiment.started
   ↓  串行（A 完成后 B 开始）
arm A: createGoalSession(input, baseline + A delta) → arm.started(rootGoalId)
       executeGoalTree → goalSnapshot → metrics → arm.ended
   ↓
arm B: 同上
   ↓
compareArms → experiment.completed
```

- **顺序执行**：两臂共享同一 Provider 配额与进程内执行锁（`ApiRuntimeService.runExclusive` 已保证同一时刻只有一个 run），并发跑会互相抢速率限制、污染耗时指标。耗时对比因此标注「顺序执行，非并发」。
- **同一工作区**：实验定义固定 `workspace`；运行期由 API 层 `setWorkspaceRoot` 后执行，两臂一致。
- **基线快照**：`baseline` 在实验定义时冻结（permissionCeiling / reasoningLevel / 挂载技能快照 `skillIds`），运行时不再重读全局——保证可复现。
- **失败语义**：单臂失败不阻断另一臂（对照实验要拿到两边的数据）；两臂都失败 → `experiment.completed` 仍写入（comparison 标注失败），整体流程只在「日志写入失败 / 创建会话失败」时落 `experiment.failed`。
- **中止（本期边界）**：实验在单次 POST 内同步完成两臂，不提供运行中停止（进程内串行锁已阻止并发实验；如需中止，等待当前臂结束或在实验台删除该实验日志）。若未来开放并发，再补 stop 语义，届时 `status='aborted'` 计入指标、实验状态标 `aborted`。
- **局部失败隔离**：任何一臂抛错都被捕获并记录为该臂的 `error`，不污染进程状态。

---

## 8. REST 接口

### 8.1 Feature

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/features` | GET | 列表 + 汇总（总数 / 开启数）+ 解析预览（全局默认） |
| `/api/features` | POST | 新建：`{ id, name, description, enabled?, promptFragment?, skills?, skillMode?, allowedTools?, reasoningLevel? }`；重复 id → 409 |
| `/api/features/:id` | GET / PATCH / DELETE | 详情 / 局部更新（含开关）/ 删除 |
| `/api/features/resolve` | POST | `{ overrides?: Record<string, boolean> }` → `EffectiveFeatures`（UI 预览与排障用） |

### 8.2 Experiment

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/experiments` | GET | 列表（按 createdAt 倒序，轻量投影：status / title / variables / 两臂指标摘要） |
| `/api/experiments` | POST | 创建并执行：`{ title, hypothesis?, input, workspace?, variables, arms, baseline? }` → 实验视图（含 comparison） |
| `/api/experiments/:id` | GET | 详情：折叠后的实验视图 + 两臂 metrics + comparison + reviews |
| `/api/experiments/:id/rerun` | POST | 用同一 spec 再跑一次（新 `experimentId`，不覆盖原记录）→ 用于方差观察 |
| `/api/experiments/:id/reviews` | POST | 追加复盘：`{ note, verdict }` |
| `/api/experiments/:id` | DELETE | 删除实验日志 |

两臂 Trace 复用既有端点：`GET /api/sessions/:rootGoalId/timeline`（快照）与 `GET /api/events/:rootGoalId`（事件流）。

**错误契约**：沿用 `{ error }` + 400/404/409/500；非法自变量（如 kind 不在闭集、arms 不是 2 个）→ 400；运行中再次提交实验 → 409（复用串行锁）。

---

## 9. WebUI

### 9.1 Settings → Features

沿用 Skills 面板形态：列表（名称 / 描述 / 开关 / 覆盖项标签）+ 新建表单（id、name、description、promptFragment、skills、allowedTools、reasoningLevel）+ 删除确认。开关改动立即写 `features.json`（无需重启，因为运行期每次解析）。

### 9.2 实验台（Experiments）

新增主视图 `ui.view = 'experiments'`（侧边栏「实验台」入口）：

```
┌ 实验台 ─────────────────────────────────────────────────────────────┐
│ [新建实验]  历史实验列表（状态徽标 / 标题 / 输入摘要 / 时间）        │
├─────────────────────────────────────────────────────────────────────┤
│ 自变量：kind= model | feature | skill | permission | reasoning       │
│   基线 A：[deepseek-chat ▾]   处理 B：[deepseek-reasoner ▾]          │
│   输入：[ 与两臂完全相同的任务 ]   工作区：[ … ]                     │
│   [运行对照实验]                                                     │
├──────────────────── A 臂 ──────────────┬──────────── B 臂 ──────────┤
│ 状态 / 模型 / 技能 / 开关               │ 状态 / 模型 / 技能 / 开关    │
│ KPI：结局 成本 token 步骤 耗时           │ 同左（同口径）              │
│ 最终输出（可折叠全文）                   │ 最终输出                    │
│ Trace：轮次表（模型/token/成本/耗时）    │ Trace：轮次表               │
│        工具调用表                        │        工具调用表           │
├─────────────────────────────────────────┴───────────────────────────┤
│ 对比：指标表（A / B / Δ / Δ% / 优者）   输出并排 diff（新增/删除行）  │
│ 复盘：[结论 A|B|平局|不确定] + 备注 → 追加 experiment.reviewed        │
└─────────────────────────────────────────────────────────────────────┘
```

- 「两个窗口」= 左右并排的两个臂面板（App 主区内容，非弹窗）。执行为同步 POST：提交后按钮置「运行中…」并禁用重复提交，两臂跑完一次性渲染；历史实验点选即载入日志折叠视图（可随时回看）；
- Trace 对比 = 同一张表的两列（同一指标口径），而不是把两个 Trace 看板并排塞进右抽屉；
- 历史复盘 = 点列表任一条 → 载入该实验视图（日志折叠结果），可继续写复盘备注。

---

## 10. 验收标准

| # | 验收项 | 标准 |
| --- | --- | --- |
| AB-1 | Feature 契约 | `resolveFeatures` 覆盖 default/override 来源、多特性交集、`only` 独占、纯函数（同输入同输出） |
| AB-2 | Feature 存储 | `features.json` 增删改查持久化；非法 id / 重复 id 拒绝；文件损坏降级为空并告警 |
| AB-3 | 只收窄 | Feature 的 `allowedTools` 与配置白名单取交集；无法通过 Feature 获得配置外的工具或更高权限 |
| AB-4 | 按运行覆盖 | 给定 `skillIds`/`promptFragment`/`allowedTools` 的 run 与缺省 run 互不影响；全局挂载状态不被实验改写 |
| AB-5 | 审计 | 运行边界发出 `flag.evaluated`，含 `harness.flag_overrides` 与 feature trace；可从事件回放本次开关 |
| AB-6 | 实验日志 | `<id>.jsonl` append-only；`foldExperiment` 可从零重放出与运行期一致的视图；无索引文件 |
| AB-7 | 控制变量 | 两臂除 `variables` 外运行参数一致；基线在定义时冻结 |
| AB-8 | 指标口径 | tokens/cost/耗时/步数/工具调用来自既有 Step 事实，口径与 Trace 看板一致 |
| AB-9 | 对比 | `compareArms` 对每项指标给出 A/B/Δ/优者；文本 diff 为纯函数，输出相同 → identical |
| AB-10 | 复盘 | `reviewed` append-only；重跑生成新实验不覆盖原记录；列表倒序可查历史 |
| AB-11 | 接口 | §8 端点全绿；非法入参 400、缺失 404、重复 409 |
| AB-12 | 面板闭环 | UI 可开关 Feature、可发起实验、可并排看输出与 Trace、可写复盘 |
| AB-13 | 回归 | `pnpm build`、`pnpm test`、`biome check` 全绿；未改动的既有能力行为不变 |

---

## 11. 非目标（明确边界）

- **不做**：LLM-as-judge 自动打分、多臂（>2）实验、显著性检验/统计推断、跨用户实验分桶（`bucketRange` 那份旧 flag 求值器不复活）；
- **不做**：把 Feature 变成插件/MCP（注册工具、放宽权限、私有存储）——那属于另一套设计；
- **不做**：实验并发执行（受进程内串行锁与厂商配额约束，顺序执行并标注）；
- **不做**：实验结果的自动回流训练（治理回路二另立项）。

---

## 12. 实现映射

| 位置 | 内容 |
| --- | --- |
| `packages/core/src/features.ts` | Feature 契约 + `resolveFeatures` 纯函数 |
| `packages/core/src/experiment.ts` | Experiment / Arm / Metrics / Comparison 契约 + `compareArms` 纯函数 |
| `packages/core/src/observability.ts` | 新增 `flag.evaluated` 属性键 `harness.feature_ids` |
| `packages/runtime/src/features/store.ts` | `features.json` 读写（File/Memory） |
| `packages/runtime/src/features/runtime.ts` | `FeatureRuntime`：CRUD + resolve |
| `packages/runtime/src/experiment/store.ts` | `ExperimentStore`（按实验 JSONL）+ `foldExperiment` |
| `packages/runtime/src/experiment/runner.ts` | `ExperimentRunner`：双臂执行 + 指标采集 + 对比落盘 |
| `packages/runtime/src/harness/runtime.ts` | 按运行覆盖（提示片段/技能集合/工具白名单）+ `flag.evaluated` |
| `packages/runtime/src/paths.ts` | `featuresFile` / `experimentsDir` |
| `packages/libs/src/text-diff.ts` | 行级 diff（LCS）纯函数 |
| `apps/api/src/features/` | §8.1 端点 |
| `apps/api/src/experiments/` | §8.2 端点 |
| `apps/webui/src/components/FeaturesPanel.vue` | 设置页开关管理 |
| `apps/webui/src/components/ExperimentsPage.vue` | 实验台（双窗 + 对比 + 复盘） |

### 12.1 提交拆分（原子提交）

1. `docs: AB 测试与 Feature 开关设计（v1.0）`
2. `feat(core): Feature 契约与解析纯函数 + Experiment 契约与确定性对比`
3. `feat(runtime): Feature 定义存储与运行时（features.json + 解析）`
4. `feat(runtime): 运行级提示/技能/工具覆盖与 flag.evaluated 审计`
5. `feat(libs): 行级文本 diff 纯函数（实验输出并排对比）`
6. `feat(runtime): 实验日志存储/折叠复盘 + 指标采集 + 对照执行器`
7. `feat(api): Feature 与 Experiment 接口（开关 CRUD/解析 + 对照实验创建/复盘/重跑）`
8. `feat(webui): 实验台（A/B 双窗 + 输出/Trace 对比 + 复盘）与 Feature 设置面板`
9. `feat(webui): 输出并排 diff 显示相似度与增删行数`
10. `docs: 更新设计文档地图与 README`

> 注：Feature 设置面板与实验台同属一条 UI 交付，合并为第 8 条提交（store 中两段状态耦合在同一文件）。

---

## 13. 风险与权衡

| 风险 | 权衡 |
| --- | --- |
| Feature 泛化成第二套 Skill | 用 §3.1 边界表与「只收窄、不注册工具」不变量约束；新增能力必须走插件/MCP |
| 顺序执行导致耗时对比不公平 | 对比表标注执行方式；耗时只作参考，成本/token/步数为主要信号 |
| JSONL 逐文件折叠在实验很多时变慢 | 本地单用户规模可接受；若超过 10^4 个实验再引入派生索引（独立立项，不预埋） |
| 提示片段可能泄漏敏感信息 | 片段是用户自己写的文本，与 Skill 正文同信任级；不参与权限判决 |
| 重跑覆盖历史 | `rerun` 生成新 experimentId；日志 append-only，无更新接口 |

---

*设计先于代码：本文件是验收唯一依据；实现与本文冲突时以本文为准，变更先改文档。*
---

## 14. 实现状态（2026-10-16）

| 提交 | 内容 |
| --- | --- |
| `556dcca` | 设计文档 |
| `e35b52d` | core：Feature 契约 + `resolveFeatures`；Experiment 契约 + `compareArms` |
| `525d5af` | runtime：`features.json` 存储 + `FeatureRuntime` |
| `c3ccb4e` | runtime：运行级 promptFragment / skillIds / allowedTools + `flag.evaluated` |
| `dbd56fc` | libs：`diffText` 行级 diff |
| `ae0bd07` | runtime：实验 JSONL 存储 + 折叠复盘 + 指标 + 执行器 |
| `c9c6b20` | api：`/api/features` + `/api/experiments` |
| `2f575b9` | webui：实验台 + Feature 设置面板 |
| `9973c1e` | webui：输出 diff 相似度 |
| `2ceeeef` | runtime/api：普通会话按全局 Feature 开关运行，恢复同样携带运行级覆盖 |

验证（本次交付末次运行）：

- `pnpm build`：6/6 成功（core / provider / libs / runtime / api / webui）；
- `pnpm test`：138 个测试文件、815 个用例全绿（新增：Feature 解析 10、Experiment 契约 7、Feature 运行时 10、运行级覆盖 6、diff 5、实验存储 8、spec 6、指标 3、执行器 3、Feature 接口 6、实验接口 5、实验服务 5、实验台投影 14）；
- `biome check`：本次新增/修改的源文件无 error（仓库既有文件存在历史 lint 诊断，未在本特性范围内改动）。

已知边界（与 §11 一致）：不做 LLM judge、多臂、显著性检验；实验串行执行；实验执行不写 Conversation。
