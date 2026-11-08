# Agent Harness 权限系统 V4：分级 + 阈值的最小模型

**文档编号**：AHF-AUTH-DESIGN-V4
**版本**：v0.2（设计稿）
**状态**：设计待评审，**未实现**
**文档定位**：对 v1/v2/v3 与当前 `packages/core/src/authz` 实现做收敛。v0.1 的七步判定仍然偏重、且把"未知命令"变成了需要维护的清单；v0.2 改为 **三级风险分级 + 三档阈值**：判定压到三步，未知命令走内置分级、不需要任何命令白名单。本文档先给设计与对比，不改代码。
**关联**：`docs/core/AHF_CORE_AUTHORIZATION.md`（v1）、`docs/core/AHF_CORE_AUTHORIZATION_V3.md`、`docs/core/AHF_CORE_TOOL-GATEWAY.md`、`docs/webui.md` §3.5。

### 修订记录

| 版本 | 变化 |
|---|---|
| v0.1 | 7 步判定；两个模式（Ask / Approve for me）；规则数据化；未知命令在两种模式下都 ask |
| v0.2 | 判定压到 **3 步**（分级 → 硬闸 → 阈值）；Approve for me 增加 **严格 / 宽松** 两档；未知命令是 **L2 分级**而不是白名单，**不需要用户维护命令清单**；规则降级为可选例外层 |

---

## 1. 一句话与结论

> 给每个动作打一个风险等级 L0–L3，模式只设置"自动放行上限"（阈值）。
> Ask = 只自动放行 L0；Approve·严格 = 自动放行到 L1；Approve·宽松 = 自动放行到 L2；L3 默认人审（红线类直接 deny），命中人工批准的记忆时放行（once-only 类别除外）。来源直通、审批记忆、可选规则只在这个阈值模型上做加减，不再有第二套判定体系。

五个结论：

1. **3 步判定**：① 分级（classify）→ ② 硬闸（guard）→ ③ 阈值（threshold + 来源/记忆/规则）。审计只是记录，不是判定步骤。
2. **未知命令不需要白名单**：内置启发式把它判为 L2（"本地、但无法确认安全"）。Ask / 严格会问，宽松会自动执行并留痕；人批准一次可选"本会话/本项目"，之后自动记住。**不需要在注册表或配置文件里逐条声明命令。**
3. **Approve for me 有两档强度**：严格（默认，L2 就 ask）与宽松（L3 才 ask）。宽松 ≈ 当前"工作区写"的 shell 免问体验，但网络/宿主机/不可逆/支付/凭证仍然 ask——它不是 Full access。
4. **规则是可选的例外层**，不是运行前提：默认跑起来不需要写任何规则；规则只用于团队收紧、或显式预授权（支付限额/域名白名单）。
5. **原则不变**：支付人审、敏感数据不出站、影响范围与可逆性决定免审边界、缺件拒绝、审计可回放。

---

## 2. 为什么这样改（v0.1 的问题）

| v0.1 的问题 | v0.2 的解法 |
|---|---|
| 7 步判定（注册/不变量/deny/来源/边界/模式/记忆）概念太多，每步都要解释 | 3 步：分级、硬闸、阈值。边界/可逆/污点/来源都折叠进"分级"和"阈值" |
| 未知命令在两种模式下都 ask，要减少询问就得给命令建白名单，太繁琐 | 未知命令 = L2；不想被问就用 Approve·宽松，或批准一次选 session/project；**没有任何命令白名单要维护** |
| 只有"问/不问"两态，用户无法表达"我能接受多大不确定性" | Approve for me 增加严格/宽松两档，本质是阈值 L1 / L2 |
| 规则层看起来是必需品（红线全在规则里） | 红线拆成：极小硬闸（代码）+ 内置分级（代码）；规则文件**可选**，只做收紧或显式预授权 |

---

## 3. 当前实现对照（事实未变）

### 3.1 调用链

```
UI 三档（只读 / 工作区写 / 完全）
  → settings.json: goal.permissionCeiling + permissions["workspace:<path>" | "conversation:<id>"]
  → Goal.permissionCeiling 钉版
  → RuntimeToolGateway
      grantForPermissionLevel → 14 capability，档内 auto / 档外 gated
      derive(meet + Q1/Q2/Q3 下限 + 硬底线 + 钉版)
  → DefaultToolGateway 8 阶段：supply→scope→risk→ledger→approval→execute→writeback→audit
  → ApprovalBroker（TTL 5 分钟，fail-closed）→ ApprovalPrompt（once/session/workspace）→ 内存 store
```

证据：`apps/webui/src/scripts/goal-contract.ts:11-30`、`packages/core/src/authz/permissions.ts:13-19`、`apps/api/src/common/runtime.service.ts:1175-1204`、`packages/runtime/src/tool-gateway/permission.ts:98-106`、`packages/core/src/authz/gateway-types.ts:233-242`、`packages/runtime/src/tool-gateway/approval.ts:66-138`。

### 3.2 真正生效的闸门（只有 5 条）

| # | 闸门 | 落点 | 实际效果 |
|---|---|---|---|
| 1 | 闭世界注册 | `gateway.ts:162-171` | 未注册工具不可调用 |
| 2 | 三问下限 + secret 写/读底线 | `risk.ts:87-124`、`gateway.ts:206-244` | 不可逆/边界写 → gated；secret 写 → forbidden；secret 读（不断流）→ 硬拒 |
| 3 | 命令分类审批 | `command.ts:135-223` | dangerous 永远逐次；readonly 按命令名记忆；unknown 按完整命令行 |
| 4 | 出站账本审批（INV-A/B） | `gateway.ts:246-281,316-326`、`ledger.ts:100-145` | 敏感读入账；出站账本破缺 → 审批 |
| 5 | 审批缺件 fail-closed | `gateway.ts:288-295` | 无审批 seam 时 gated 调用拒绝 |

### 3.3 有设计、但生产路径无消费方的机制

沙箱、出网代理、`SecretService` 断流、压缩继承账本、污点阻断、`maxLabel`、支付限额、签名审计链、疲劳度量 R/F1/F2、用户标注加载——均只有接口/类型/测试，**没有真实执行**。证据：`core/src/authz/sandbox.ts:11-37`、`runtime/src/harness/tool-executor.ts:250`（"beyond CWD 不隔离"）、`runtime/src/tool-gateway/permission.ts:236`（账本每网关新建）、`gateway.ts:389-391,440`（taint 只展示）、`permission.ts:294-303`（`untrusted` 标志被丢弃）、`trust.ts:88-170`、`telemetry.ts:39-107`。

**这正是简化的依据**：v0.2 只保留有消费路径的 5 条闸门，其余删除或降级。

### 3.4 当前实现的十个问题

| 编号 | 问题 | 主要证据 |
|---|---|---|
| I1 | 名义档位与实际边界脱节（模式改可触达范围） | `tool-gateway/permission.ts:1-11,98-106` |
| I2 | "工作区写"下未知 shell 自动执行且无沙箱；`echo x > ~/.bashrc` 可越域 | `tool-gateway/permission.ts:49-55`、`command.ts:160,219-223`、`tool-executor.ts:250` |
| I3 | "只读"可经一次 workspace 授权长期自动执行 | `gateway.ts:444-478` |
| I4 | UI 3 档 / core 5 档 / 运行时 6 档；`workspace-write` 不在类型里 | `goal-contract.ts:14`、`permissions.ts:13-19`、`health.controller.ts:8-12` |
| I5 | `workspace` 作用域忽略路径、仅内存、无撤销入口 | `gateway-types.ts:180-193`、`runtime.ts:205` |
| I6 | 支付原则无实现（无 pay 工具/限额/收款方） | `tool-gateway/permission.ts:33,61` |
| I7 | 敏感数据半实现：`.env` 硬拒无解锁、账本单 run、污点不裁决 | `gateway.ts:223-234`、`ledger.ts` |
| I8 | 文档承诺 > 实际强制（沙箱/代理/断流/签名链/疲劳度量未接线） | §3.3 |
| I9 | "完全"名不副实（危险命令仍拦） | `gateway.ts:284-287`、`goal-contract.ts:25` |
| I10 | 事件契约漂移（rejected 复用 cancelled、审批事件缺 key） | `tool-gateway/approval.ts:124`、`arm-live.ts:128-135` |

---

## 4. 与用户建议的对比

### 4.1 五步管线 → 3 步判定

| 用户建议 | v0.2 落点 | 说明 |
|---|---|---|
| 1. 来源判定 → 直接放行 | **第 3 步内的"阈值提升"**：人类本轮明确 + 参数逐字一致 → 阈值临时抬到 L2 | 保留"用户敲的命令不再问"；不给 L3 开口子 |
| 2. 红线规则（含条件） | **第 1 步"分级"里的 L3 + 第 2 步硬闸 + 可选规则文件** | 红线从"必写规则"变成"内置分级 + 5 条硬闸" |
| 3. 沙箱能兜住 → allow | **不假装有**：域/可逆性进分级；当前无 OS 沙箱，如实披露，P3 再补 | 现状为 0 |
| 4. 可逆且边界内 → allow | **第 1 步分级**：workspace + reversible → L1；越域/不可逆 → L3 | 可逆性作为分级输入 |
| 5. 兜底 ask 人工 | **第 3 步阈值** + once/session/project 记忆 + fail-closed | 阈值决定问不问，记忆决定问过之后 |

用户管线里"来源判定放第一"与我们"硬闸先于来源"的差异见 §5.3：来源只抬阈值、不绕过 deny/L3。

### 4.2 未知命令到底怎么处理（直接回答）

**不需要在注册表或配置里声明白名单。** 处理顺序：

1. 内置命令分析给出分级（详见 §5.1）：只读 → L0；已知常规构建/测试 → L1；危险/解释器/网络/含 shell 元字符/引用工作区外路径 → L3；**其余未知的简单命令 → L2**。
2. L2 的含义是"本地、但无法确认安全"，不是"危险"，也不是"安全"：
   - Ask：ask；
   - Approve·严格：ask；
   - Approve·宽松：**自动执行 + 审计**（这就是宽松档存在的意义）。
3. 被问之后，人可以选"允许一次 / 本会话 / 本项目"。选后同指纹命令自动记住，**下次不用再问，也不用写配置**。泛化（如 `npm run deploy` → 任意 `npm run *`）不会自动学，需要显式配置。
4. 团队想强制收紧时，才写一条项目规则（如 `unknown: ask`），属于可选能力，不是运行前提。

所以：**白名单不是权限系统的必需品；它是"规则层"的一个可选用法。** 默认体验由内置分级 + 模式阈值提供。

### 4.3 为 Approve for me 增加"严格 / 宽松"

| 档位 | 自动放行上限 | 仍然会问 | 定位 |
|---|---|---|---|
| Ask | L0（只读） | L1–L3 | 陌生项目/高风险 |
| Approve·严格（默认） | L1（工作区可逆写、已知常规命令） | L2（未知本地命令）、L3 | 日常默认 |
| Approve·宽松 | L2（未知本地命令也自动） | L3（网络/外发/宿主机/不可逆/支付/凭证/规则） | 低摩擦，信任项目与 Agent |

> 表中的"会问"是首次行为；命中人工批准的记忆（once/session/project）时不再问，once-only 类别除外。

- **宽松不是 Full access**：L3 永远问；硬闸永远生效；沙箱/边界不变。
- **严格与宽松只差一个阈值**，实现上是同一个 `mode.level` 参数（0/1/2），不是两套代码。
- 默认严格；切宽松需要显式选择并接受一次性风险提示（可被项目规则强制锁回严格）。

### 4.4 三方总表

| 维度 | 当前实现 | 用户建议 | v0.2 |
|---|---|---|---|
| 用户可见 | 3 档 | 自动 + ask，可分层 | **Ask / Approve·严格 / Approve·宽松**（内部是 mode + level） |
| 模式语义 | 能力天花板 | 策略预设 | **自动放行阈值**，不改变边界 |
| 判定步数 | 8 阶段 + derive + Q1-Q3 | 5 步 | **3 步**（分级→硬闸→阈值） |
| 未知命令 | 工作区写下自动执行（无沙箱），危险命令才问 | 未明确 | **L2：严格问、宽松自动、可记忆**，无白名单 |
| 规则 | 命令规则数据化，红线硬编码 | 全局+项目两级规则 | 内置分级 + 可选规则层（只做收紧/预授权） |
| 支付 | 仅类型 | 保留原则 | L3 + 可选规则（限额/收款方） |
| 敏感数据 | 账本真、断流/污点假 | 污点近似 | 硬闸 secret + taint-lite 出站判定 |
| 影响范围 | Domain 未使用 | 影响面 | 域+可逆性进 L1/L3 分级 |
| 审批记忆 | once/session/workspace（内存） | 三种 allow | once/session/**project**（持久化、可撤销） |

---

## 5. 设计

### 5.1 风险分级 L0–L3

分级是纯函数：`classify(toolPolicy, args, taint) → { level, effect, domain, reversibility, targets, scopes }`。

| 等级 | 名称 | 典型 | 判据 |
|---|---|---|---|
| **L0** | 安全只读 | 读文件、rg、git status、ls | 工具声明 `effect=read`；命令是只读头且无 shell 元字符 |
| **L1** | 常规可逆 | 编辑工作区文件、格式化、`npm test`、构建 | 目标在 workspace；可逆/可重生成；命令属内置常规类别 |
| **L2** | 不确定（本地） | 未知简单命令、`npm run <任意脚本>`、运行工作区脚本 | 无明显危险、无 shell 元字符、未引用工作区外路径，但无法确认安全 |
| **L3** | 严重 | `rm`、`git push --force`、`curl`、写 `~/.ssh`、支付、发布、读 `.env`、改规则 | 不可逆；越域（host/external）；网络；含 shell 元字符/解释器/内联代码；凭证；规则文件；未归类工具 |

**分级不是白名单**：它由内置启发式（代码内，产品维护）计算；用户不需要逐条声明命令。

内置命令启发式（与现有 `commands.json` 合并为"内置默认 + 可选覆盖"）：

| 类别 | 规则 | 等级 |
|---|---|---|
| 只读头 | `ls/cat/rg/fd/git status/diff/log/ping/dig/...` + 无 `; & | < > \` $()` 等元字符 | L0 |
| 常规构建 | 包管理器 `test/build/lint/fmt/typecheck`、`pytest/vitest/jest/tsc/biome`、`cargo/go test`、`make` 的已知目标；`npm run <script>` 仅当 script 名属于内置安全名（test/build/lint/fmt/typecheck） | L1 |
| 自定义脚本 | `npm run deploy`、`make deploy` 等无法确认目标的脚本 | L2 |
| 危险头 | `rm/dd/mkfs/chmod/chown/mv/cp/tee/sudo/...` | L3（灾难模式 deny） |
| 解释器/内联 | `sh -c`、`bash -c`、`python -c`、`node -e`、`eval/exec/source` | L3 |
| 解释器跑脚本 | `python script.py`、`node script.js`（脚本在 workspace） | L2 |
| 网络 | `curl/wget`、`xh`、`git push/fetch` | L3 |
| 元字符 | 管道/重定向/命令替换/多行 | L3（无法分析） |
| 越域引用 | 参数含绝对路径、`~`、`..` 逃出 workspace | L3 |
| 其他未知 | 无上述特征 | L2 |

工具级声明（`ToolPolicy`，见附录 B）优先于命令启发式：`effect=read/write/exec/fetch/send/publish/payment/delete`、`reversibility`、`domain`、参数投影。**新工具未声明策略 → 归为 L3 + 全部模式 ask**（fail-safe；这是工具提供方写一次，不是用户日常维护）。

各等级的默认可授予 scope：L0–L2 为 `once/session/project`；L3 默认 `once`，其中网络读取（fetch）例外为 `once/session/project`（人批准一次等于信任该 host 组合）；未归类工具为 `once`。

污点（taint）只会上调等级：`taint=sensitive` + 出站 → L3；`taint=secret` + 出站 → 硬闸 deny；`taint=secret` 本身会让后续读取 secret 的路径保持 L3。

### 5.2 模式 = 阈值

| 模式 | 内部参数 | 自动放行 | 会 ask |
|---|---|---|---|
| Ask | threshold = L0 | L0 | L1 / L2 / L3 |
| Approve·严格（默认） | threshold = L1 | L0 / L1 | L2 / L3 |
| Approve·宽松 | threshold = L2 | L0 / L1 / L2 | L3 |

补充规则：

1. **来源直通**：人类本轮明确指令 + 参数逐字一致 + 期间无 untrusted 内容 → `threshold = max(threshold, L2)`（只对当前调用）。它让 Ask 模式下"用户自己敲的命令"也免问，但 L3 仍问。
2. **审批记忆**：一次 ask 后可选 once/session/project；命中后同指纹直接 allow（L3 中不可记忆的类别除外）。**记忆不改变阈值，只回答本次 ask。**
3. **规则层**（可选）：deny/ask 可收紧任意等级；allow 可预授权（如支付限额、域名白名单）。规则不能越过硬闸。
4. **宽松的边界不变**：网络/宿主机/外发/发布/不可逆/支付/凭证/规则修改仍是 L3，宽松也 ask。

模式选择的 UI：

```
权限：[ Ask（逐项确认） ▾ ]
      ├─ Ask · 逐项确认        写文件、跑命令、联网都先问
      ├─ Approve for me · 严格  工作区可逆操作自动；未知命令/联网/不可逆仍问
      └─ Approve for me · 宽松  未知本地命令也自动；严重操作仍问（风险提示）
```

内部存 `mode: 'ask' | 'approve'` + `level: 'strict' | 'loose'`，旧档位映射见 §8。

### 5.3 三步判定管线

```ts
decide(call, ctx): Decision {
  // ① 分级：纯函数，无副作用
  tool = registry.get(call.tool);
  if (!tool) return deny('UNREGISTERED');
  plan = classify(tool.policy, call.args, ctx.taint);
  // plan = { level: 0|1|2|3, effect, domain, reversibility, targets, scopes }
  if (plan.unclassifiedTool) return ask('UNCLASSIFIED_TOOL', { scopes: ['once'] });

  // ② 硬闸：任何模式、任何配置、任何人指令都不放宽
  if (plan.secretWrite)                    return deny('SECRET_WRITE');
  if (plan.secretRead && !ctx.unlocked)    return deny('SECRET_READ');
  if (ctx.taint === 'secret' && plan.egress)
                                           return deny('SECRET_EGRESS');
  if (plan.catastrophic)                   return deny('CATASTROPHIC');
  if (plan.policyWrite)                    return ask('POLICY_SELF_MODIFY', { scopes: ['once'] });
  const rule = evaluateRules(plan, ctx);   // 可选：deny / ask / allow
  if (rule?.action === 'deny')             return deny(rule.id);

  // ③ 阈值：规则收紧 → 来源抬升 → 规则放行 → 阈值 → 记忆 → ask
  if (rule?.action === 'ask')              return ask(rule.id);
  let threshold = MODE_THRESHOLD[ctx.mode.level];   // ask:0 / strict:1 / loose:2
  if (isHumanExplicit(call, ctx))
      threshold = Math.max(threshold, 2);           // 只抬到 L2，L3 仍 ask
  if (rule?.action === 'allow')            return allow(rule.id);
  if (plan.level <= threshold)             return allow('CLASSIFIED');
  if (ctx.memory.find(plan, ctx))          return allow('APPROVED_BEFORE');
  if (!ctx.approvalAvailable)              return deny('APPROVAL_UNAVAILABLE');
  return ask('THRESHOLD', { scopes: plan.scopes });
}
```

每一步的失败方向：

| 步骤 | 决策 | 失败方向 |
|---|---|---|
| ① 分级 | 未注册 deny；未归类 L3+ask；其余 L0–L3 | fail-safe，未知偏保守 |
| ② 硬闸 | deny / ask-once（规则 deny 也在此拦） | fail-closed，不可被来源或模式绕过 |
| ③ 阈值 | allow / ask；记忆命中可 allow | 无审批者 → deny；L3 不可记忆类只 once |

**为什么不是"来源判定第一步"**：来源直通在实现里只是"把阈值临时抬到 L2"，天然排在硬闸之后；这既保留了"用户亲手敲的命令不再问"，又不会让注入内容/转述借"用户说过"越过 deny 与 L3。这是对用户方案唯一的修正。

### 5.4 审批记忆：once / session / project

| 作用域 | 生命周期 | 存储 | 适用 |
|---|---|---|---|
| `once` | 本次调用 | 不落盘 | 所有 ask；L3 默认只允许这个 |
| `session` | 当前会话 | 内存，含 sessionId | L2 未知命令、网络读取（人类显式批准后）、L1 |
| `project` | 当前工作区，跨会话/重启 | `<MAZI_HOME>/config/auth/approvals.json`，按 workspace 路径索引 | L1/L2；网络读取（等于项目级域名信任）；Settings 可撤销 |

规则（对应"信任累积但单向"）：

1. **只有人能创建记忆**：UI 的允许按钮或人直接编辑文件；自动审核永不写记忆。
2. **指纹绑定**：命令按归一化命令行、文件写按工具+路径、网络按 host、支付按 payee+金额+用途；不绑定能力类别。只读命令可按命令名粒度记忆。
3. **不可记忆类别**：不可逆、支付、凭证、规则修改、宿主机/系统操作 → 只能 `once`（UI 不显示其他按钮）。网络读取可 `session/project`（人显式批准 = 信任该 host 组合）。
4. **泛化必须显式**：`npm test` → `npm run *` 不会自动学；要么人直接改规则，要么逐条批准。
5. **收紧容易、放松难**：Agent 只能读规则/记忆；任何写入命中 `POLICY_SELF_MODIFY`（ask once）；项目规则默认只收紧。
6. **可撤销、可过期**：project 记忆在 Settings 列出、可逐条撤销；可配过期时间；规则/工具策略版本变化时失效清理。

### 5.5 硬闸（代码）与可选规则层

**硬闸只有 5 类（代码，不可配置放宽）**：

1. 未注册工具 → deny；未归类工具 → ask。
2. secret 写 → deny；secret 读未解锁 → deny；`taint=secret` 时任何出站 → deny。
3. 灾难模式（`rm -rf /`、`mkfs`、`dd of=/dev/*`、fork bomb）→ deny。
4. 权限规则/工具策略文件写入 → ask once（防自我提权）。
5. 审批不可用且需要人审 → deny（fail-closed）。

**规则层（可选）** 只做三件事：

| 用途 | 例子 | 默认 |
|---|---|---|
| 收紧 | 项目禁用 `git push`，或所有 `unknown` 强制 ask | 可随时加 |
| 预授权 allow | 支付 ≤ 限额 + 收款方白名单；域名 allowlist | 必须由人写 |
| 单命令例外 | 团队约定某命令必须逐次审批 | 可随时加 |

规则文件（可选）：

- 全局：`<MAZI_HOME>/config/auth/permissions.json`
- 项目：`<workspace>/.mazi/permissions.json`（默认**只能收紧**；放宽需人打开 `trustProjectRules`）

规则求值：硬闸之后、阈值之前；deny/ask 无论等级一律生效；allow 只对"人写配置"生效且入审计；**不参与"未知命令是否有害"的推断**——那由分级负责。

> 关键区别：v0.1 把规则当主判定，导致"要免问就得写白名单"；v0.2 把规则降为可选的收紧/预授权层，默认行为完全由分级 + 阈值决定。

### 5.6 数据流污点（lite）

- 每个会话维护 `taint: none | sensitive | secret` 与来源（路径/host/tool）。
- `ingest` 工具命中 `sensitivePaths` → sensitive；命中 secret（仅解锁后可能）→ secret。
- 出站动作（send/publish/网络命令/支付）：sensitive → 至少 L3（ask）；secret → 硬闸 deny。
- 清除：新会话或人工显式"重置数据流"；**压缩不清除**（保留 v3 防"洗账"的结论）。
- 不做全量账本/残留文件追踪（P2 可选）；如实声明"文件作为中继"这一缺口。

### 5.7 Approve·宽松下"谁在批"

v4.0 没有 AI 自评：宽松的自动放行来自**分级阈值**（L0–L2），确定性、可解释、可审计。P3 可选独立 reviewer 只处理灰区（L2），必须满足：独立实例、不读整段不可信上下文、只能 allow/ask、不确定就 ask、只对本次有效、不能写记忆/规则。AI 只缩小灰区，不替代红线。

### 5.8 审计

每次 `decide()` 一条记录：

```ts
interface PolicyDecision {
  decisionId: string; ts: number;
  sessionId: string; workspacePath: string;
  mode: 'ask' | 'approve'; level: 'strict' | 'loose';
  tool: string; actionDigest: string;
  riskLevel: 0 | 1 | 2 | 3;
  effect: EffectKind;
  domain: 'sandbox' | 'workspace' | 'host' | 'external';
  reversibility: 'reversible' | 'compensable' | 'irreversible';
  taint: 'none' | 'sensitive' | 'secret';
  provenance: 'human-explicit' | 'agent';
  threshold: 0 | 1 | 2;
  ruleId?: string;
  outcome: 'allow' | 'ask' | 'deny';
  reason: string;
  approval?: { scope: 'once' | 'session' | 'project'; by: 'user'; latencyMs: number };
  policyVersion: string;
}
```

事件：`policy.decision` 每条 + 现有 `approval.requested/granted/denied/cancelled`（补齐 `actionDigest/ruleId/scopes/riskLevel`）。复用现有事件总线（JSONL + 哈希链）回放。审批回显保留：工具、动作摘要、目标、命令、host、金额/收款方/用途、等级、污点来源、规则 id、允许的 scope。

---

## 6. 与现有代码的映射

### 6.1 保留

`ApprovalBroker` 与 TTL fail-closed、审批 UI/store、`/api/approvals`、事件总线与行为流、`effect-store` 回滚、路径 glob 与动作指纹工具、审批 echo/summarize（补字段）。

### 6.2 改造

| 模块 | 动作 |
|---|---|
| `permissions.ts`（5 档） | → `mode.ts`：`mode: ask \| approve` + `level: strict \| loose` |
| `tool-gateway/permission.ts`（305 行） | → `decision-gateway.ts`（约 120 行）：注册 → 分级 → decide → 适配 `ToolCallResult` |
| `core/authz/gateway.ts`（503 行，8 阶段） | → `permission/decide.ts`（约 150 行，3 步）+ `permission/classify.ts`（约 150 行） |
| `core/authz/command.ts` + `command-policy.ts` | 保留命令分析，改为返回 L0–L3；内置启发式 + 可选覆盖 |
| `runtime/config.ts`、`builtin.ts` | `minPermission/sideEffects` → `ToolPolicy` |
| API/UI 的 `permissionCeiling`、scoped permissions | → `mode` + `level`（解析优先级不变） |
| 审批作用域 | `workspace` → `project`，持久化 + 撤销 |

### 6.3 删除

`types.ts` 的 Grant/CapabilitySpec/EffectTier/PinnedVersions/Question、`derive.ts`、`risk.ts`（并入分级）、`labels.ts`（只留 secret/sensitive 路径清单）、`ledger.ts`、`secret.ts`、`trust.ts`、`telemetry.ts`、`egress.ts`、`sandbox.ts`（P3 真接入时再建）、`gateway-types.ts` 的 8 阶段契约、`permissions.ts` 档位；运行时的 `grantForPermissionLevel`/derive 调用/`ToolSpec`/`coCapabilities`；规划与实验台的档位概念。

### 6.4 新增

```
packages/core/src/permission/
  types.ts        # Mode/Level/RiskLevel/EffectKind/Domain/Decision/ToolPolicy
  classify.ts     # 分级：工具策略 + 命令启发式 + taint
  decide.ts       # 3 步管线
  rules.ts        # 可选规则层：解析、合并、求值
packages/runtime/src/permission/
  tool-policy.ts        # 内置工具 ToolPolicy、未归类 fail-safe
  decision-gateway.ts
  approval-memory.ts    # once/session/project
```

目标：约 500–700 行实现 + 约 800–1000 行测试（比 v0.1 再降一档）。

---

## 7. 场景走查

| # | 场景 | 等级 | Ask | Approve·严格 | Approve·宽松 |
|---|---|---|---|---|---|
| 1 | `cat src/app.ts` | L0 | allow | allow | allow |
| 2 | 编辑 `src/app.ts` | L1 | ask | allow | allow |
| 3 | `npm test` | L1 | ask | allow | allow |
| 4 | `npm run build` | L1 | ask | allow | allow |
| 5 | `python3 scripts/gen.py`（未知但本地） | L2 | ask | ask | **allow**（留痕） |
| 6 | `make deploy`（未知目标） | L2 | ask | ask | **allow**（留痕，可被项目规则收紧） |
| 7 | `npm run deploy` | L2 | ask | ask | allow（留痕） |
| 8 | `rm -rf dist` | L3 | ask once | ask once | ask once |
| 9 | `curl https://x` | L3 | ask once/session | ask | ask |
| 10 | 写 `~/.bashrc` | L3（越域） | ask once | ask once | ask once |
| 11 | `git push --force` | L3 | ask once | ask once | ask once |
| 12 | 读 `.env` | 硬闸 | deny | deny | deny |
| 13 | 读 `customers.csv` 后 `curl` | 硬闸/ L3 | deny/ask | deny/ask | deny/ask |
| 14 | 支付 ¥5（白名单内） | L3 | ask | ask（规则 allow 则 allow+审计） | 同左 |
| 15 | 写 `.mazi/permissions.json` | 硬闸 ask once | ask | ask | ask |
| 16 | 未归类新工具 | L3+askAll | ask | ask | ask |
| 17 | 用户当轮："运行 `pnpm build`"，模型执行同命令 | L1 → 来源直通 | **allow** | allow | allow |
| 18 | 网页内容诱导 `rm -rf /` | L3/灾难 | deny | deny | deny |
| 19 | 批准"本会话允许 `python3 scripts/gen.py`" | L2 记忆 | 后续同指纹 allow | 同左 | 同左 |
| 20 | 非交互遇到 L2/L3 | — | deny（无审批者） | deny | deny |
| 21 | 项目规则要求 unknown 一律 ask | L2 收紧 | ask | ask | ask（宽松被收紧） |

关键行为变化（相对当前）：
- 宽松下 `python3 scripts/gen.py`、`make deploy` 会自动执行——这是用户要的"没有严重风险就放开"；严格下会问。
- 任何网络/越域/不可逆/支付在宽松下仍然问；当前"工作区写"下 `curl` 其实可能自动执行，v0.2 反而更严。

---

## 8. 迁移计划与验收

### 8.1 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 设计** | 确认 §9 决策 | 用户确认 mode/level 命名与默认 |
| **P1 词汇** | `mode` + `level` 进配置/API/UI；旧档位映射：`read-only → ask`、`workspace-write → approve·strict`、`autonomous → approve·loose`（提示"宽松仍有 L3 人审"）、`text → ask + 空工具面` | 三个端点同一集合；旧 settings 可升级 |
| **P2 分级引擎** | `classify.ts` + `ToolPolicy` + 命令启发式；`decision-gateway` 替换旧判权；规则层可选加载 | 场景 1–18 全过；`classify` 纯函数单测 |
| **P3 记忆/污点** | once/session/project 持久化 + Settings 撤销；taint；事件补字段 | 场景 19–21；重启后 project 记忆仍在 |
| **P4 清理** | 删除 §6.3；docs 同步；grep 无旧档位 | lint + test 通过 |

### 8.2 验收

- 矩阵：`等级 L0–L3 × 模式 3 档 × taint 3 态 × 域 4 类` 断言 outcome 与 scope；由 `ToolPolicy`/分级表机械生成。
- 红队：注入诱导、项目规则放宽、shell 元字符绕过 readonly、`~/.bashrc` 越域、`.env` 后外发、宽松下未知命令留痕、非交互 fail-closed。
- 回放：从 `policy.decision` 重建一次 ask（等级 → 阈值 → 规则 → 审批 → scope）。

---

## 9. 待决策

| # | 问题 | 建议 |
|---|---|---|
| D1 | 默认档位？ | **Approve·严格**。宽松需显式切换并接受提示；安全优先 |
| D2 | 宽松下未知命令自动执行，接受吗？ | 这是 v0.2 的核心取舍：**接受**（L2 自动、留痕、可被项目规则收紧）；若把 L2 改成宽松也 ask，宽松档就退化回严格档，失去意义 |
| D3 | 网络/越域/不可逆在宽松下是否也自动？ | **不**。它们是 L3，宽松只到 L2；这也是"宽松 ≠ Full access"的边界 |
| D4 | 来源直通的上限？ | **L2**：用户亲手敲的普通命令免问，但 `rm/curl/.env` 等 L3 仍问（可配置放开） |
| D5 | 命令白名单要不要？ | **不要**。内置分级 + 记忆 + 可选规则三层已经覆盖；白名单只作为项目规则的可选写法 |
| D6 | UI 呈现？ | 一个选择器三项（Ask / Approve·严格 / Approve·宽松），内部 model 仍是 mode+level |

---

## 附录 A：风险分级速查（实现时直接照此写）

```text
未注册工具                     → deny
未归类工具（无 ToolPolicy）     → L3 + ask all（once）
effect=read & 无副作用          → L0
effect=write & workspace & 可逆 → L1
effect=delete / irreversible    → L3
effect=fetch                    → L3（网络；可被规则/记忆预授权）
effect=send/publish/payment     → L3
domain=host/external            → L3
secret 读/写                    → 硬闸 deny
policy 文件写                   → 硬闸 ask once
灾难命令                        → 硬闸 deny
未知命令                        → L2（严格问 / 宽松自动）
```

## 附录 B：ToolPolicy

```ts
interface ToolPolicy {
  effect: 'read' | 'write' | 'exec' | 'fetch' | 'send' | 'publish' | 'payment' | 'delete' | 'delegate';
  reversibility: 'reversible' | 'compensable' | 'irreversible';
  domain: 'sandbox' | 'workspace' | 'host' | 'external';
  targets?: {
    pathParams?: string[]; hostParams?: string[]; commandParam?: string; commandPrefix?: string;
    amountParam?: string; payeeParam?: string; purposeParam?: string;
  };
  ingest?: boolean;          // 输出进上下文，用于 taint
  untrustedOutput?: boolean; // 网络/MCP 输出，不触发来源直通
}
```

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| 等级 Level | L0 只读 / L1 常规可逆 / L2 不确定 / L3 严重 |
| 模式 Mode | ask / approve（Approve 带 level：strict / loose） |
| 阈值 Threshold | 自动放行的最高等级：Ask=0、严格=1、宽松=2 |
| 硬闸 Guard | 5 类代码级、不可放宽的 deny/ask-once |
| 审批记忆 Grant | once / session / project |
| 来源直通 | 人类明确指令把阈值临时抬到 L2 |
| 规则 Rule | 可选例外层：收紧或显式预授权 |

## 附录 D：原则保留

| 原原则 | v0.2 落点 |
|---|---|
| 授权只在人、Agent 不能自提权 | 硬闸 `POLICY_SELF_MODIFY`；记忆只能人创建 |
| 单向收紧 | 项目规则只收紧；泛化必须人显式配置 |
| 不可逆/支付/发布必须人审 | 归为 L3，宽松也 ask |
| 支付限额是唯一预授权 | 可选规则 `pay.limit`，allow 需人写并审计 |
| 敏感数据不出站 | secret 读写 deny、taint=secret 出站 deny、敏感出站 L3 |
| 影响范围/可逆性 | 分级 L1 vs L3；域与可逆性是核心判据 |
| 缺件拒绝、审计可回放 | 无审批者 deny；`policy.decision` + 事件哈希链 |
| 新工具默认不可信 | 未归类工具 L3 + ask all |
| （删除）沙箱/代理/签名 TCB/疲劳度量/钉版 | P3 再评估；文档明确披露 |
