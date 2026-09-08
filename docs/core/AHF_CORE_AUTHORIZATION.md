# Agent Harness 权限系统设计

**文档版本**：v1 | **状态**：设计定稿 | **关联**：TaskContract 契约体系权限子规范

## 1. 概述

### 1.1 目的

定义 Agent 系统中权限的生命周期管理：从用户授予、任务派生收缩、到调用时强制执行的完整链路，并覆盖文件、网络、数据库、资金等效果域的治理规则。

### 1.2 设计立场

权限经历三段生命：**根层被授予（一次）→ 派生时被计算（每契约一次）→ 调用时被强制执行（每次调用）**。强制点在操作系统内核，审批是唯一逃生舱，模型全程只有请求权。

### 1.3 术语

| 术语            | 定义                                                 |
| --------------- | ---------------------------------------------------- |
| EffectClass     | 权限原子：资源×操作的类别（如`fs.write.sandbox`） |
| EffectTier      | 三档：`auto` / `gated` / `forbidden`           |
| AgentGrant      | 根层授权数据，用户签署，唯一授予点                   |
| EffectivePolicy | 运行时计算出的生效权限，永不持久化                   |
| DangerRule      | 高危值层覆盖规则：命令模式/敏感路径/金额             |
| Capacity        | 统一调用咽喉，所有工具调用的唯一出口                 |

---

## 2. 设计原则

| #   | 原则                                                                                           |
| --- | ---------------------------------------------------------------------------------------------- |
| P1  | 授权只发生于根层；`full-access` 永不出现在派生路径                                           |
| P2  | 任务层只有请求权，数据结构上无法表达授予                                                       |
| P3  | effective 是计算值，无持久化可编辑形态                                                         |
| P4  | 三档制 + 范围白名单预授权（确认按不可逆性收费）                                                |
| P5  | 权威链是合取（meet），任何层只能收紧                                                           |
| P6  | 提示不是安全边界，内核强制才是                                                                 |
| P7  | fail-closed：沙盒/审批缺件即拒绝                                                               |
| P8  | 经验主义优先：默认 on-failure 触发升权，不要求模型先知                                         |
| P9  | 模型可见的与审计记录的是同一份状态                                                             |
| P10 | **高危操作与权限档位无关：任何配置下，破坏性命令、敏感路径、资金操作一律人工确认或禁止** |

---

## 3. 体系结构

```
GrantStore(根层签署) ──► PolicyResolver(派生: meet+守卫+封顶) ──► Capacity(执行咽喉)
     │ 一次性                 │ 每契约一次                        │ 每次调用
     ▼                        ▼                                  ▼
  AgentGrant            EffectivePolicy                管线: 身份→供给→档位→
                                                          范围→高危→预算→执行
旁轨: DecisionLog · Budget Meter · Approval Seam · Kill Switch(格之外)
底部: 沙盒后端(Landlock/Seatbelt) · Egress Proxy
```

---

## 4. 权限模型

### 4.1 EffectClass

```typescript
export type EffectClass =
    | 'fs.read.workspace' | 'fs.read.host'
    | 'fs.write.draft' | 'fs.write.sandbox' | 'fs.write.workspace'
    | 'fs.exec'
    | 'net.fetch' | 'net.send'
    | 'db.read' | 'db.write' | 'db.schema'
    | 'publish' | 'pay' | 'delete'
    | `external.${string}`;        // 全信外部进程(MCP 等)
```

设计要点：**可逆性入类型**（draft/sandbox/workspace 分档）；**fetch（入口注入风险）与 send（出口外泄风险）分离**；`db.schema` 承载 DDL 类不可逆结构变更；`pay` 独立于 `net.send`——网络支付是资金效果而非通信效果。

### 4.2 恒 gated 类（白名单不豁免）

以下类别在任何层级、任何配置下 tier 下限为 `gated`，且范围白名单不产生预授权豁免，必须逐次走人工审批：

| 类别           | 理由                           |
| -------------- | ------------------------------ |
| `delete`     | 不可逆删除                     |
| `db.schema`  | DROP/TRUNCATE 类不可逆结构变更 |
| `pay`        | 资金流出，不可逆               |
| `publish`    | 公开不可撤回                   |
| `external.*` | 不受沙盒约束的进程             |

### 4.3 EffectRule

```typescript
export interface EffectRule {
    tier: EffectTier;
    trigger?: 'on-failure' | 'on-request';  // 省略 = on-failure
    paths?: string[];     // glob 方言, 语义由单测固定
    hosts?: string[];     // net.*, egress proxy 执行
    amountLimit?: Money;  // 仅 pay: 单笔预授权上限
}
```

### 4.4 根层授予与任务层请求

```typescript
export type AgentGrant = Partial<Record<EffectClass, EffectRule>> & {
    budget?: { steps?: number; tokens?: number; cost?: number };
};
export const PRESETS = {
    'read-only':       { 'fs.read.workspace': { tier: 'auto' } },
    'workspace':       { 'fs.read.workspace': { tier: 'auto' },
                         'fs.write.draft':    { tier: 'auto' },
                         'fs.write.sandbox':  { tier: 'auto' } },
    'workspace-write': { 'fs.read.workspace': { tier: 'auto' },
                         'fs.write.workspace':{ tier: 'auto' } },
} satisfies Record<string, AgentGrant>;
export function fullAccessGrant(rootContractId: ContractId): AgentGrant;
// 仅根层可调用（P1）；注意 full-access 也不豁免恒 gated 类与 DangerRule
export interface TaskPolicyRequest {
    requires: EffectClass[];                          // 必需, 派生时 fail-fast
    wants?: Partial<Record<EffectClass, EffectRule>>; // 非必需, 参与 meet
}
```

---

## 5. 策略派生

### 5.1 meet 语义

| 轴                          | 规则                                               |
| --------------------------- | -------------------------------------------------- |
| tier                        | 取严者；恒 gated 类下限钳制在此之后强制            |
| trigger                     | 取更保守者                                         |
| paths / hosts / amountLimit | 集合交；amountLimit 取较小者；`undefined` 为顶元 |
| 未声明类别                  | `forbidden`（closed-world）                      |

### 5.2 派生流程

```
derive(parent, request):
  1. requires 逐项对照父层, forbidden → fail-fast 发起 ContractRevision(不 spawn)
  2. wants 与父层 meet, 构造性收紧
  3. 危险组合守卫(§8.4) 全局检查
  4. 后端能力封顶(§10.2): 不可强制执行的轴封顶 gated
  5. 恒 gated 钳制(§4.2) 最后强制, 任何 meet 结果无法低于下限
  → EffectivePolicy { derivedFrom: parentId@version }
```

**子层变宽的唯一路径是人**（ContractRevision → 根授权 v+1 → 重派生）。
--------------------------------------------------------------------

## 6. Capacity 执行管线

```
模型产出 tool_call(仅 tool + args)
 ① 身份绑定: harness 注入 contractId, 模型无法选择身份
 ② 策略解析: effective 缓存命中(父版本失效)
 ③ 供给检查: 工具注册过? 无注册即 forbidden
 ④ 单调守卫: pre-execute 钩子, deny 后本次调用不可翻回
 ⑤ 档位分派: forbidden → 拒绝 / auto → 值层 / gated → 范围判定
 ⑥ 值层范围: args 投影 path/host/amount ∈ policy?
     命中 → 预授权静默放行(恒 gated 类除外)
     未命中 → 升权协议或审批
 ⑦ DangerRule 匹配(§8): 命中即按规则强制 forbidden / 人工确认
 ⑧ 预算扣减
 ⑨ 环境部署执行: Deployer 按 effectClass 配沙盒, handler 无特权
 ⑩ 出口加工 + 记账
```

**两层检查缺一不可**：派生时算策略层（范围∩范围），⑥⑦ 算值层（本次值是否落域内/命中高危）。
三态返回：`executed` / `pending(handle)`（入审批队列）/ `rejected(code, hint)`。拒绝必须是结构化可行动的（`FORBIDDEN_BY_POLICY` 附带更窄替代建议、`GATED_REJECTED` 明示勿重试同类），裸 `permission denied` 是 agent 死循环的头号来源。
------------------------------------------------------------------------------------------------------------------------------

## 7. 升权协议

| 规则          | 内容                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| 统一入口      | 升权是 Capacity 层通用协议，不挂在任何工具 schema 上                                                      |
| 已生效短路    | 非严格更宽的请求（相等/更窄/不可比较）→ 视为普通调用直行，不报错不入审批                                 |
| justification | 仅严格更宽时校验非空                                                                                      |
| 审批语义      | `allowed-once`：批准只适用本次动作，绝不回写 grant                                                      |
| 重试纪律      | 每次被拒至多一次升权重试；effective 已触顶时提示为「绕开」而非「可升权」                                  |
| 触发方式      | on-failure（默认，内核 EPERM 翻译为策略性拒绝后自动构造）/ on-request（模型显式）/ predeclare（requires） |
| 阻塞性        | 交互单契约 → 同步；并发 >1 → 非阻塞队列，push 优先                                                      |

---

## 8. 高危操作治理（DangerRule 覆盖层）

**本层与权限档位正交**：无论 grant 如何配置、tier 是什么，高危规则一律生效。它是平台上限的组成部分，不参与 meet——**任何层都不能通过派生放宽高危规则**。

### 8.1 三类高危面

| 高危面     | 载体          | 示例                                                                                                          |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| 破坏性命令 | 命令/语句模式 | `rm`（非回收站）、`DROP TABLE`、`TRUNCATE`、`mkfs`、`shred`、`dd of=/dev/*`、`git push --force` |
| 敏感路径   | 路径 glob     | 秘密文件、用户数据、系统配置                                                                                  |
| 资金操作   | pay 类 + 金额 | 支付、转账、订阅                                                                                              |

### 8.2 规则结构

```typescript
export interface DangerRule {
    id: string;
    match: {
        commandPatterns?: RegExp[];    // rm\s+-[rf], DROP\s+(TABLE|DATABASE), ...
        sqlPredicates?: string[];      // 'delete-without-where', 'drop', 'truncate'
        pathGlobs?: string[];          // ~/.ssh/**, /etc/**, **/.env
        effectClasses?: EffectClass[];
    };
    outcome: 'forbidden' | 'always-gated';   // always-gated = 白名单不豁免
    reason: string;                          // 全量入 decisionLog
}
```

### 8.3 内置敏感路径注册表

| 类别     | 路径示例                                                                              | 读                                                           | 写                                   |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| 秘密     | `~/.ssh/**`、`**/.env`、`**/*.pem`、`**/id_rsa*`、`**/credentials*`、钥匙串 | **恒 gated**（外泄防线：秘密+net.send 是数据外泄管道） | **forbidden**                  |
| 系统配置 | `/etc/**`、`/usr/**`、`/bin/**`、`/System/**`、注册表                         | gated                                                        | **恒 gated**，关键项 forbidden |
| 用户数据 | workspace 之外的家目录内容                                                            | 显式授予，默认 forbidden                                     | 默认 forbidden                       |

注册表内置且用户可追加；**即使 paths 白名单显式包含敏感路径，DangerRule 依然覆盖**——白名单不豁免原则的路径应用。

### 8.4 命令级谓词与组合守卫

- 命令谓词在值层对 bash/SQL 调用内容匹配：`rm` → `delete` 语义（恒 gated）；`DROP/TRUNCATE` → `db.schema`（恒 gated）；`DELETE FROM` 无 WHERE → 保守 gated（SQL 解析可判则静态判，不可判保守处理）。
- 危险组合守卫在**派生时**对 effective 全局运行：| 组合                                                | 风险       | 处置                                     |
  | --------------------------------------------------- | ---------- | ---------------------------------------- |
  | `fs.read.host` ≥gated + `net.send: auto`       | 外泄管道   | `net.send` → gated                    |
  | `fs.read.workspace` ≥gated + `net.fetch: auto` | 注入入口   | `net.fetch` → gated，内容标 untrusted |
  | `net.fetch: auto` + `fs.exec: auto`             | 下载即执行 | `fs.exec` → gated                     |

### 8.5 匹配位置与审计

- 派生时：守卫与封顶收敛，运行时无策略级惊喜。
- 调用时：DangerRule 值层匹配在范围检查之后、执行之前（管线 ⑦）。
- 命中即记 `danger-match` 事件（一等风险事件），含规则 id、匹配内容摘要、处置结果。

---

## 9. 网络与资金

### 9.1 网络

- **egress proxy 是唯一出口**：工具进程网络命名空间无直连能力；域名校验发生在**连接时**（解析→pin IP→建连→二次解析不一致即拒），防 DNS rebinding。
- `net.fetch` 返回内容统一打 **untrusted 标记**：作为数据进入上下文，不作为指令。本系统不治理注入的内容层防御，只把注入成功的爆炸半径压到最小。

### 9.2 资金（pay 类专项规则）

| 规则                                                                              | 内容                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 恒 gated                                                                          | 任何层级不可设 auto，白名单不豁免                                                      |
| 金额预授权                                                                        | `amountLimit` 是 pay 唯一允许的预授权形态：单笔 ≤ 限额时可静默放行 + 日志；超限必问 |
| 审批回显                                                                          | 审批请求必须携带交易摘要（收款方、金额、用途），人确认的是具体交易而非类别             |
| 重复防护                                                                          | 同一收款方短窗口内重复扣款 → 强制再次确认（防重放与误重复）                           |
| 订阅类                                                                            | 自动续费/订阅开通默认 forbidden，需根契约显式条款级授权                                |
| `net.send` 治理通信外泄；`pay` 治理资金流出——两者是不同的效果面，分别建模。 |                                                                                        |

---

## 10. 沙盒强制与环境绑定

### 10.1 后端选型（fail-closed）

| 平台                                                                                                   | 后端链                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Linux                                                                                                  | bwrap → Landlock + seccomp 原生启动器 |
| macOS                                                                                                  | Seatbelt                               |
| Windows                                                                                                | 受限写 token（能力受限，见 10.2）      |
| 请求受限模式但无可用后端 →`SANDBOX_UNAVAILABLE`，拒绝在无沙盒下运行。审批服务缺位同样 fail-closed。 |                                        |

### 10.2 能力矩阵封顶

后端无法强制执行的轴（如 Windows 的读/网络），对应 effectClass 的 tier 被**封顶在 gated**——无法内核兜底的效果永不无人值守，跨平台语义由 spec + 能力矩阵共同保证。

### 10.3 环境绑定三规则

1. **handler 无特权**：执行环境（沙盒 root、网络命名空间）由 Deployer 按 effectClass 统一配置，handler 内部永不做权限判断。
2. **代码执行同轨**：`run_code`/解释器类工具的载荷执行环境必须套用与工具调用相同的内核 profile——`run_code` 内的 `import('fs')` 落在与外部调用相同的权限格与 DangerRule 约束内。
3. **外部进程显式标注**：无法 confine 的进程（MCP server）注册为 `external.<name>`，恒 gated，每次调用记 `full-trust-invocation` 风险事件。

---

## 11. 中止权与审计

**Kill switch 在权限格之外**：独立控制通道（进程信号 + 沙盒销毁两级），不经 policy 管线，任何 policy 不可阻挡——权限格回答「模型能做什么」，kill switch 回答「人还能不能叫停」，后者是前者存在的前提。

**decisionLog 事件**：`clamp` / `guard-downgrade` / `derive-reject` / `grant-revision` / `escalation-*` / `danger-match` / `full-trust-invocation` / `sandbox-unavailable`。

**归因完备**：`契约 spec(v) + derivedFrom + decisionLog` 三联可回答「这个效果是在哪一层的哪次决定下被放行的」。**模型可见 = 已记录**：策略快照从 session log 派生注入上下文，变更才注入以保持 KV 前缀稳定。

## 12. 不变量

| #             | 不变量                                                                 | 执行点                         |
| ------------- | ---------------------------------------------------------------------- | ------------------------------ |
| V1            | 授权只在根层                                                           | `fullAccessGrant()` 根层断言 |
| V2            | 任务层无授予字段                                                       | GrantStore schema 校验         |
| V3            | effective 是计算值                                                     | 缓存随父版本失效               |
| V4            | 派生单调收紧                                                           | meet + 单测基线                |
| V5            | closed-world                                                           | 供给检查                       |
| V6            | 唯一咽喉 + 环境按 effectClass 绑定                                     | Capacity 管道 + Deployer       |
| V7            | 守卫派生时全局执行                                                     | applyGuards                    |
| V8            | delete/db.schema/pay/publish/external 恒 gated，白名单不豁免           | 钳制 + 硬编码                  |
| V9            | kill switch 在格之外                                                   | 独立通道                       |
| V10           | 每次放行可归因                                                         | 三联回放                       |
| V11           | 调用身份由 harness 注入                                                | 管线 ①                        |
| V12           | 非严格更宽的升权请求 = 普通调用直行                                    | 偏序短路                       |
| V13           | fail-closed                                                            | 沙盒/审批/代理缺件即拒         |
| V14           | 一次调用内 deny 单调不可翻                                             | pre-execute 钩子               |
| V15           | 不可强制执行的效果永不 auto                                            | 能力矩阵封顶                   |
| **V16** | **DangerRule 不参与 meet，任何层不可放宽；full-access 亦不豁免** | **值层覆盖层**           |
| **V17** | **秘密路径读恒 gated；秘密路径写 forbidden**                     | **敏感注册表**           |
| **V18** | **pay 审批必带交易摘要，限额是唯一预授权形态**                   | **审批 seam**            |

---

## 13. 示例走查

| 场景                             | 链路                                                                 | 结果                                                     |
| -------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm install`                  | 根层`net.fetch: gated {hosts:[npmjs.org]}` → 值层命中白名单       | 静默放行，无人                                           |
| `rm -rf src/`                  | `fs.exec: auto`（假设）→ DangerRule 命中 `rm` → delete 语义    | **恒 gated**：入审批，「删除已入队待批，我先继续」 |
| `DROP TABLE users`             | `db.write: auto`（假设）→ SQL 谓词命中 `drop` → db.schema 语义 | **恒 gated**，白名单不豁免                         |
| 写`~/.ssh/config`              | paths 落在敏感注册表 → 写 forbidden                                 | **拒绝**，可行动提示绕开                           |
| 读`.env` + 外发                | 读命中秘密注册表 → 恒 gated；组合守卫`net.send` 已 gated          | 双重防线，均需人工                                       |
| 支付 ¥50                        | 根层`pay: gated {amountLimit: ¥100}` → 单笔 ≤ 限额              | 静默放行 + danger-match 日志                             |
| 支付 ¥5000                      | 超 amountLimit                                                       | 审批必带交易摘要回显                                     |
| `run_code` 内 `import('fs')` | worker thread 套同款 Landlock profile                                | 与外部调用同权限格、同 DangerRule                        |
| 模型携带同档升权字段             | V12 偏序短路                                                         | 按普通调用直行，无死循环                                 |

---

## 14. 实现计划

| 阶段 | 内容                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | EffectClass 注册表、类型与 schema 校验、`derive()` + meet + V12 偏序单测全矩阵、GrantStore                                                      |
| P1   | Capacity 管道（身份/供给/分派/值层/记账）、统一升权协议、Approval Seam（allowed-once、fail-closed、阻塞性自适应）、结构化 RejectCode + EPERM 翻译 |
| P2   | DangerRule 引擎（命令谓词、敏感路径注册表、V16–V18）、恒 gated 钳制、组合守卫                                                                    |
| P3   | 沙盒后端链 + 能力矩阵封顶、Deployer 环境绑定、egress proxy（连接时校验 + IP pinning + untrusted 管线）、kill switch                               |
| P4   | ContractRevision 工作流、decisionLog 三联回放视图、PRESETS + 授权包（带过期）、模板库（shadow→trusted→auto）                                    |

---

## 附录：设计来源

| 来源             | 吸收                                                                                      | 修正其缺陷                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Codex            | 内核强制哲学（P6）、on-failure 触发（P8）、云端形态、PR 审批面                            | MCP 信任缺口 → external.* 显式标注                                              |
| deepseek-harness | 管道 + 单调守卫（V14）、fail-closed（V13）、审批独立 seam、可见即记录（P9）、后端选型链   | 升权死循环 → V12；网络词汇缺失 → net 一等公民；run_code 旁路 → 环境绑定三规则 |
| 本设计           | 契约树派生、三档+预授权、requires fail-fast、恒 gated 纪律、DangerRule 覆盖层（V16–V18） | —                                                                               |

---

**总结**：一条链（grant→derive→enforce），一个原子（EffectClass×Tier），三扇门（范围预授权、人工审批、格外中止），一层不可谈判的覆盖（DangerRule——破坏性命令、敏感路径、资金操作在任何配置下都过人或被拒）。人的注意力只花在事前边界、事中例外、事后翻案三处；中间的一切在机器闭环完成，且每个已发生的效果可归因到一次显式决定。
