
# ToolGateway 设计文档

**文档版本**：v1.0 | **状态**：设计定稿 | **关联**：《Agent Harness 权限系统设计 v1.1》（父规范，下称 Perm-v1.1）；AHF v2 分层架构（宿主架构）

**契约位置**：`packages/core/src/tool-gateway.ts` | **实现位置**：`packages/executor/src/gateway/`

## 1. 概述

### 1.1 定位

ToolGateway 是工具调用的**统一出口与唯一咽喉**。权限三段生命——grant（根层签署）→ derive（派生计算）→ enforce（调用时强制）——中，它承担第三段的全部行为接口。
Perm-v1.1 中的“Capacity 执行管线”（十步管线）在本设计中被正式化为一等组件并命名。父文档定义权限的**数据语义**，本文档定义强制执行点的**行为契约**。

### 1.2 供给面与执行面的分工

|                                                                                                                                                                                                             | Capacity                 | ToolGateway                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------- |
| 回答                                                                                                                                                                                                        | 这一轮**允许什么** | 这一次调用**是否放行、如何执行** |
| 形态                                                                                                                                                                                                        | 静态数据包               | 动态行为组件                           |
| 生产者                                                                                                                                                                                                      | planner（L2）组装        | executor（L2）持有                     |
| 生命周期                                                                                                                                                                                                    | Turn 创建时              | Turn 绑定实例，Turn 结束即弃           |
| 交接发生在 executor 为 Turn 构造 Gateway 实例时：从 Capacity 取`effectivePolicy` / `dangerRules` / `budget` / `sandbox`，连同 harness 注入的 `sessionId` / `turnId` 填入 `GatewayBindInput`。 |                          |                                        |

### 1.3 隐喻与词汇对齐

模型 = 用户态，工具 = 内核资源，Gateway = syscall trap。每次 tool_call 陷入此处，harness 做检查、审批、记账、fail-closed。接口词汇与 v2 观测事件同源：`invoke` / `result` / `blocked`——无翻译层。

### 1.4 术语

| 术语                | 定义                                                                |
| ------------------- | ------------------------------------------------------------------- |
| 锚点（effectClass） | 派单判定的主效果类，tier 分派与审计的归因主键                       |
| coEffects           | 联合检查面：一次调用同时涉及的其他效果类（如支付 = pay + net.send） |
| 供给过滤            | 按 effective 剔除 forbidden 工具的白名单收缩                        |
| 值层投影            | 从 args 提取 path/host/amount/command/sql 供检查的产物              |
| pending handle      | 审批未决调用的句柄                                                  |
| D1–D3              | 沙盒部署约定（§7）                                                 |

---

## 2. 设计原则

| #   | 原则                                                                                          |
| --- | --------------------------------------------------------------------------------------------- |
| P1  | **唯一咽喉**：所有工具调用必经 invoke，无旁路；出现旁路即安全事件                       |
| P2  | **供给 ≠ 边界**：tools 白名单是体验优化；幻觉与伪造调用照样被 ②④⑤ 拦截              |
| P3  | **强制的两种形态**：管道强制判锚点与值，内核强制（沙盒）判内容面——bash 类工具靠此分工 |
| P4  | **身份不可伪造**：InvocationRequest 无身份字段；身份构造时注入                          |
| P5  | **拒绝必须可行动**：结构化三态 + hint；裸 permission denied 是死循环头号来源            |
| P6  | **emit 不受 flag 控制**：审计事件永续产生，flag 只控制 sink 消费                        |
| P7  | **handler 无特权**：权限检查一个执行点（管线），环境部署一个执行点（Deployer）          |
| P8  | **fail-closed**：审批缺位 / secrets 不可解析 / 沙盒不可用 → 拒绝，绝不挂起             |
| P9  | **工具按效果面切分，不按能力切分**：generic `http(method, url, body)` 是反模式        |
| P10 | **编排不是工具**：skill 走 spawn 递归，不注册（§6.4）                                  |

---

## 3. 体系结构

```
L0  core                    tool-gateway.ts（本契约） + authorization.ts + approval.ts
                            + observability.ts —— 全部 import type，零运行时依赖
        ▲
L1  policy                  ApprovalGate implements ApprovalSeam（审批队列、allowed-once）
        ▲
L2  executor                gateway/：DefaultToolGatewayFactory + 管线实现
                            （pipeline / value-check / budget-meter / deployer）
        ▲
L3.5 harness-runtime        组合根：装配 Factory 的审批、审计、钩子依赖（依赖倒置）
        ▲
L4  apps                    createHarness()，可整体替换 Gateway 实现做 A/B
```

依赖倒置要点：executor 只 import `@core` 接口；`GatewayBindInput` 中的 `approval` / `audit` / `hooks` 全部以接口注入。A/B 闭环：flag 在组合根分流两个 Gateway 实现，planner / strategy 无感知——“开关即架构”在执行面的落法。

## 4. 核心数据模型（契约速览）

契约代码即规范，此处只列语义要点：

| 结构              | 要点                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| ToolRegistration  | 注册点（V5 closed-world）。effectClass 锚点 + coEffects 联合面 + scope 值层投影声明 + trust + secrets + handler |
| ToolSpec          | 供给视图：联合分派后最严档（forbidden 已剔除，恒 gated 与 full-trust 钳为 gated）                               |
| InvocationRequest | 仅 tool + args + 可选 escalation；无身份字段（V11）                                                             |
| InvocationResult  | 三态：executed(value, untrusted?) / pending(handle) / rejected(code, hint, dangerRuleId?)                       |
| GatewayHook       | preExecute verdict + 只读 postExecute；deny 单调（V14）                                                         |
| GatewayAuditEvent | 必带 stage + decision + TraceIdentifiers 三层 ID                                                                |
| ToolGateway       | invoke / checkPending / settle；每实例绑定一个 Turn                                                             |
| GatewayBindInput  | 身份（注入）+ 权限数据（派生产物）+ 周边服务；无任何字段能凭空放宽权限                                          |


`HandlerContext` 刻意最小化：只有 `AbortSignal`。没有 policy 访问、没有注册表、没有权限判断 API——handler 结构上无法做权限判断（P7）。

## 5. invoke 管线（11 阶段）

| #  | 阶段                     | 语义                                                                                                                  | 失败模式                                     |
| -- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| ① | escalation-short-circuit | V12 偏序短路（§8.1）                                                                                                 | 无——非升权直行                             |
| ② | supply-check             | 工具 ∈ 注册表 + schema 校验                                                                                          | `FORBIDDEN_UNREGISTERED`                   |
| ③ | hook-chain               | pre-execute 钩子链，deny 吸收态                                                                                       | 钩子自定 code                                |
| ④ | tier-dispatch            | 联合分派：锚点 + coEffects 各查 effective，任一 forbidden 即拒，全体取严 governs                                      | `FORBIDDEN_BY_POLICY`                      |
| ⑤ | scope-check              | 值层范围：各类 scope（paths/hosts/amountLimit）分别检查；命中 → 预授权静默放行（V8 恒 gated 除外）；任一未命中 → ⑥ | 转 ⑥                                        |
| ⑥ | danger-match             | DangerRule 值层匹配（命令模式 / SQL 谓词 / 敏感路径），命中按 outcome 处置                                            | `FORBIDDEN_BY_DANGER_RULE` / 转 ⑦         |
| ⑦ | approval                 | ApprovalSeam 请求，返回 pending(handle)；服务缺位 fail-closed                                                         | `GATED_PENDING` / `APPROVAL_UNAVAILABLE` |
| ⑧ | budget                   | steps/tokens/cost 原子扣减；settle 执行前复查                                                                         | `BUDGET_EXHAUSTED`                         |
| ⑨ | execute                  | handler 在沙盒内无特权执行；环境按 D1–D3 部署                                                                        | handler 异常 / 超时                          |
| ⑩ | output-taint             | `untrustedOutput` → 返回值打标，作为数据进入上下文                                                                 | —                                           |
| ⑪ | audit                    | 全阶段决策事件入 audit sink                                                                                           | —                                           |

**阶段常量 `GATEWAY_PIPELINE_STAGES` 是验收基线**：实现阶段名与之一致，审计事件才可横向比较；实现测试逐阶段断言。

---

## 6. 能力覆盖：四类形态

### 6.1 bash——效果面动态的工具

命令内容决定实际读什么、写什么、连什么，静态 effectClass 无法预判。三层组合覆盖：

1. **锚点**：`fs.exec`——分派只判进程生成本身；
2. **值层**：`commandParam` 投影 → ⑥ 拦危险命令（`rm -rf` / `DROP TABLE` / `git push --force`）；
3. **沙盒（D1）**：命令内容的 fs/net 面由内核强制，不由网关判。
   **一注册吃遍所有命令，不按命令拆分。** 越界命令得到 EPERM → 翻译为策略性拒绝 → on-failure 升权（经验主义优先）。

### 6.2 网络接口

- **单效果**：`http_get` → `net.fetch` + `hostParams` 白名单 + D2 proxy——直接成立。
- **多效果**：支付 API = `pay`（资金流出）+ `net.send`（网络出口）→ `coEffects` 联合分派：两类均须非 forbidden、tier 取严、amountLimit 与 hosts 白名单分别值层检查；凭证走 `secrets`。
- **切分原则（P9）**：method 决定 fetch/send 语义的 generic http 工具是反模式——拆分注册，派单才可静态判定。

### 6.3 MCP

逐工具映射注册，四件套：

| 支撑点   | 机制                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| 效果映射 | 按语义映射（filesystem →`fs.read.host`；create_issue → `publish`）；映射不了兜底 `external.<server>`（恒 gated） |
| 进程信任 | `trust: 'full'` → tier 下限强制 gated + 每次调用记一等风险事件                                                        |
| 注入面   | `untrustedOutput: true` **默认**——server 返回文本是模型可见的外部内容                                          |
| 凭证     | `secrets`（token 注入进程环境，永不入 args）                                                                           |

MCP`inputSchema` 与 `JSONSchemaSpec` 直接兼容，adapter 只做搬运；动态发现（list_tools → 同步注册表）是 executor 层 adapter 职责。

### 6.4 skill——反模式警示

把 skill 注册为 ToolRegistration 是**类别错误**：skill 是多步编排，其 handler 内部必须发起工具调用——handler 无特权纯逻辑，内部再调工具即出现**第二执行点**（V6 直接违反；dsh `run_code` 事故的结构形态）。
正确物化路径：

```
SkillManifest { prompt, toolNames[], policyTemplate: TaskPolicyRequest }
  → spawn 子 Turn → derive(policyTemplate) → 子 Gateway 实例
  → skill 内部每次工具调用都经过子 Gateway 完整管线
```

合法的递归是 **spawn → derive → 新 Gateway**，不是 handler 内嵌 Gateway。skill 权限从 policyTemplate 派生收缩，与任何子任务同权、同审计，无需合成 effectClass。

## 7. 沙盒部署约定（Deployer 的三条约）

| #  | 约定            | 内容                                                                                                                                                                                                   |
| -- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 | fs.exec 沙盒    | profile 派生自**整个 effective 的 fs/net 面**（read 规则 → 读范围，write → 写范围，net → 无网络命名空间或仅 proxy），而非仅 fs.exec 一条。命令内越界 → 内核 EPERM → 翻译 → on-failure 升权 |
| D2 | net.* 部署      | handler 执行环境为仅 proxy 出口的网络命名空间，无直连；域名校验发生在连接时（解析 → pin IP → 建连 → 二次解析不一致即拒，防 DNS rebinding）                                                          |
| D3 | full-trust 部署 | `trust: 'full'` 工具在沙盒外执行；secrets 解析注入进程环境，**永不出现在 args（模型可见面）与 ToolSpec（供给面）**；解析失败 fail-closed；每次调用记一等风险事件                               |

---

## 8. 审批与升权协议

### 8.1 升权短路（V12）

仅当 `requested` 相对 effective **严格更宽**（档位更高，或同档且 scope 严格扩大）时才进入 justification 校验与审批链；**相等 / 更窄 / 不可比较 → 实现必须整体忽略 escalation 字段，按普通调用直行**——不报错、不降级、不进审批、不校验 justification。此为 dsh 升权死循环的结构性修复。偏序判定函数在 executor 实现，语义期望矩阵在 `core/src/semantics.ts`。

### 8.2 allowed-once 语义

- 审批请求携带 payload（命令 / 路径 / 金额 / 域名）与 dangerRuleId——人批的是**具体动作**，不是类别；
- `settle(handle, { decision: 'granted' })` → 按原请求执行**一次**，绝不回写 grant；权限持久变化只走 ContractRevision；
- **settle 复查**：granted 执行前必须复查预算（⑧）与钩子仍有效——防审批等待期间预算耗尽后仍执行；
- 通道：executor 循环 push 注入为主，`checkPending` pull 查询为辅；
- 阻塞性：交互单契约同步；并发 > 1 → 非阻塞队列（继承 Perm-v1.1 §7）。

---

## 9. 审计与观测

- 每阶段决策事件：stage ∈ GATEWAY_PIPELINE_STAGES、decision ∈ allowed/denied/pending/info、TraceIdentifiers 三层 ID 必备（缺一即实现缺陷）；
- **被拦截的尝试也必须留痕**——“agent 想做什么但被挡了”是安全分析一等信号；
- emit 永不被 flag 阻断（v2 原则 4：flag 只控制 sink 消费）；
- 归因（V10）：`契约 spec(v) + GatewayBindInput + 审计事件流` 三联可回答“这次调用是在哪条规则、哪个阶段的哪次决定下被放行的”。

---

## 10. kill switch

在权限格之外（继承 Perm-v1.1 §11）：独立控制通道，不经 policy 管线，任何 policy 不可阻挡。Gateway 内的落点是 `HandlerContext.signal`——构造时聚合三个源：工具级 timeout、预算中止、kill switch 源；signal 触发后执行中 handler 必须可中断。权限格回答“模型能做什么”，kill switch 回答“人还能不能叫停”——后者是前者存在的前提。

## 11. 不变量

继承 Perm-v1.1 编号，新增 G 系：

| #   | 不变量                                             | 执行点                                  |
| --- | -------------------------------------------------- | --------------------------------------- |
| V5  | closed-world：无注册即 forbidden                   | ②                                      |
| V6  | 唯一咽喉 + handler 无特权                          | invoke 唯一入口 + HandlerContext 最小化 |
| V8  | 恒 gated 类白名单不豁免                            | ④⑤ 钳制                               |
| V9  | 模型可见 = 已记录                                  | ToolSpec 与审计同源                     |
| V10 | 每次放行可归因                                     | ⑪ + 三联回放                           |
| V11 | 调用身份由 harness 注入                            | 构造时，请求结构无身份字段              |
| V12 | 非严格更宽的升权 = 普通调用直行                    | ① 偏序短路                             |
| V13 | fail-closed                                        | ⑦ 审批缺位 / D3 secrets 失败           |
| V14 | 一次调用内 deny 单调不可翻转                       | ③ 吸收态                               |
| G1  | 供给过滤非安全边界，幻觉调用照样拦                 | ②④⑤                                  |
| G2  | 实现阶段名与 GATEWAY_PIPELINE_STAGES 对齐          | ⑪                                      |
| G3  | secrets 不出现在 args 与 ToolSpec                  | D3 + 类型结构保证                       |
| G4  | settle 复查预算与钩子                              | settle                                  |
| G5  | 并发调用的预算扣减原子                             | ⑧                                      |
| G6  | skill 不注册，物化为 spawn → derive → 子 Gateway | §6.4                                   |

## 12. 示例走查

| 场景                    | 管线路径                                 | 结果                                            |
| ----------------------- | ---------------------------------------- | ----------------------------------------------- |
| `npm install`         | ④ net.fetch gated + ⑤ hosts 白名单命中 | executed（预授权静默）                          |
| `rm -rf src/`         | ④ fs.exec + ⑥ cmd.rm 命中              | **pending**（恒 gated，审批）             |
| `DROP TABLE users`    | ⑥ sql.drop 命中                         | **pending**（白名单不豁免）               |
| 写`~/.ssh/config`     | ⑥ 敏感路径注册表                        | **rejected** `FORBIDDEN_BY_DANGER_RULE` |
| 幻觉调用未注册工具      | ② 供给检查                              | **rejected** `FORBIDDEN_UNREGISTERED`   |
| 支付 ¥50（限额 ¥100） | ④ pay+net.send 取严 + ⑤ amount ≤ 限额 | executed + danger 日志                          |
| 支付 ¥5000             | ⑤ amount 超限                           | pending（审批带交易摘要）                       |
| bash 内`curl` 越网    | ⑨ D1 沙盒强制                           | EPERM → 翻译 → on-failure 升权                |
| 模型携带同档升权字段    | ① 偏序短路                              | 按普通调用直行，无死循环                        |
| 审批 granted 后预算耗尽 | settle 复查（G4）                        | rejected`BUDGET_EXHAUSTED`                    |
| MCP create_issue        | ④ publish 恒 gated + D3 全信执行        | pending / 审批后执行，记风险事件                |

---

## 13. 实现计划与测试基线

| 阶段 | 内容                                                                                    |
| ---- | --------------------------------------------------------------------------------------- |
| P0   | core 契约定型；`semantics.ts` 期望矩阵（V12 偏序全矩阵、meet 基线、V14 吸收态）       |
| P1   | executor 管线：11 阶段逐段断言；三态返回；结构化 RejectCode + EPERM 翻译通道            |
| P2   | 值层：ScopeProjector + glob + DangerRule 匹配（命令/SQL/敏感路径全用例）；钩子链        |
| P3   | Deployer D1–D3 + secrets 解析 + kill switch 信号聚合（timeout/预算/kill 三源）         |
| P4   | 审批 seam 集成（allowed-once、settle 复查、fail-closed）；MCP adapter；skill spawn 物化 |

**测试基线**：实现测试必须引用 `GATEWAY_PIPELINE_STAGES` 逐阶段断言；四类能力注册用例（bash / http_get / charge / mcp / skill-manifest）在 `__tests__/registrations.ts` 做类型校验。

---

## 附录 A：命名决策记录

| 候选                  | 裁决 | 理由                                                                                                                                       |
| --------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Capacity              | ❌   | v2 已占用（planner 组装的资源包），一词两义                                                                                                |
| tool                  | ❌   | 与 ToolRegistration/ToolSpec 自撞，命名空间内部污染                                                                                        |
| skill                 | ❌   | 社区已占用为认知层概念（知识/技能包）；且 skill 恰是本设计明确不注册的东西                                                                 |
| ability               | ❌   | 与 capability 近义，语义泥潭                                                                                                               |
| hand                  | ❌   | 身体隐喻孤立违和，需全体系配合                                                                                                             |
| executor / dispatcher | ❌   | 前者被 v2 占用（Step 执行大概念）；后者弱化守门语义                                                                                        |
| **ToolGateway** | ✅   | 唯一通道 + 过门检查；与 egress proxy 意象互证（体系内两个受控通道同构）；syscall trap 对齐；与`tool.invoke/blocked` 事件词汇同源；无撞名 |

## 附录 B：与 Perm-v1.1 十步管线的映射

| v1.1 阶段     | 本设计                                             |
| ------------- | -------------------------------------------------- |
| ① 身份绑定   | 上移至**构造时**（forTurn 注入，V11 结构化） |
| ② 策略解析   | 上移至 planner（Capacity 已含 effective）          |
| ③ 供给检查   | ②                                                 |
| ④ 单调守卫   | ③（钩子契约化）                                   |
| ⑤ 档位分派   | ④（扩展为 coEffects 联合分派）                    |
| ⑥ 值层范围   | ⑤                                                 |
| ⑦ DangerRule | ⑥（独立阶段）                                     |
| ⑧ 预算       | ⑧（新增 settle 复查）                             |
| ⑨ 沙盒执行   | ⑨ + D1–D3 约定化                                 |
| ⑩ 出口记账   | ⑩⑪ 拆分（打标与审计分离）                        |
| （新增）      | ① 升权短路独立成阶段（V12）                       |

## 附录 C：设计来源

| 来源      | 吸收                                                                 | 修正其缺陷                                                                       |
| --------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Perm-v1.1 | 三段生命、恒 gated、DangerRule 覆盖层、fail-closed、kill switch 格外 | 十步管线 → 11 阶段契约化（身份/策略上移、短路独立）                             |
| dsh       | 管道 + 单调守卫（V14）、EPERM 翻译、结构化拒绝                       | 升权死循环 → ① 短路；`run_code` 旁路 → P7 最小 Context + skill 反模式（G6） |
| Codex     | 内核强制哲学 → D1（bash 效果面交沙盒）                              | MCP 信任缺口 → trust:full + external 兜底 + 一等风险事件                        |

---

**一句话总结**：ToolGateway 是权限系统 enforce 段的正式化——一条 11 阶段管线、一个三态出口、两种强制形态（管道判锚点与值，沙盒判内容）、四类能力的统一覆盖（bash 靠分工、网络靠切分、MCP 靠映射、skill 靠 spawn）。供给面 Capacity 说“允许什么”，执行面 ToolGateway 说“这次是否放行”；两层之间没有旁路，每一层都有审计。
