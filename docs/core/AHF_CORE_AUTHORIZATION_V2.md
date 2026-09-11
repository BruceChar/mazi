# Agent Harness 权限系统设计

**版本**：v2

**状态**：设计定稿

---

## 1. 概述

### 1.1 目的与分工

本文档定义 Agent 系统中权限的**数据语义**——从根层授予、任务派生收缩、到调用时强制的完整链路，以及文件、网络、数据库、资金等效果域的治理规则。强制执行的行为面（管线阶段、审批 seam、审计事件结构、kill switch 落点、并发执行语义）由配套的 ToolGateway 文档定义。

本文档回答：**权限是什么**——三原语、六规则、授予与派生、标注层、数据流账、可信基治理、根信任。ToolGateway 回答：**强制怎么发生**。

### 1.2 设计立场

权限经历三段生命：

```
根层被授予（一次） → 派生时被计算（每契约一次） → 调用时被强制执行（每次调用）
```

强制点在操作系统内核，审批是唯一逃生舱，模型全程只有请求权。

**关键立场**：内核强制保证**无旁路**，但内核执行的是策略——**策略错了，强制也错**。因此本设计不仅定义策略语义，也定义策略供给链的可信基（TCB）与 TCB 之根（根信任锚）。策略正确性不靠单点承诺，而靠结构化的版本治理、形式化、属性测试与红队。

### 1.3 风险公理

#### 1.3.1 三问公理

风险的承载者不是操作动词。`fs.write` 写沙箱临时文件无害，`fs.read` 读秘密路径危险——判定任一操作的风险，依次询问三问：

| 问                                                                   | 判什么                  | 风险类型         | 典型                                              |
| -------------------------------------------------------------------- | ----------------------- | ---------------- | ------------------------------------------------- |
| **Q1**：它**现在**就产生不可撤回的后果吗？               | 后果的时点与可逆性      | 直接 committed   | pay / delete / DROP / publish / 外部进程          |
| **Q2**：它在**为未来供料**吗？（把内容搬进模型上下文）   | 数据流方向              | source / tainted | 读敏感资产、fetch 不可信内容                      |
| **Q3**：它在**扩大未来的行动空间**吗？（改权限包络本身） | 是否实质修改 AgentGrant | 边界写           | authorized_keys / crontab / rc / hooks / 自身策略 |

三问皆否 = 无风险。沙箱写无害，是因为沙箱使 Q1/Q2/Q3 同时为假：整体销毁即撤销、边界封闭搬不出、够不到权限包络。**动词只是三问的载体**。

#### 1.3.2 枢纽公理

模型上下文窗口是**万能中转枢纽**。任何 source 的产物可被同一上下文内任何后续 sink 的 args 复述出去——这是 Agent 与经典进程模型的本质差异。sink 还可在同一上下文内被事后升权请求——**source 的危险性与系统的升权柔性成正比**。

#### 1.3.3 上下文世代公理

模型上下文的生命周期单元是**上下文世代**（Context Generation）：

- **起点**：新 session 创建 / 显式 flush / 上下文压缩后重建
- **终点**：下一次 flush / 上下文销毁

敏感内容一旦进入上下文，其残余风险延续到世代结束。因此，数据流账的默认记账单元是**上下文世代**，而非单次 Turn——Turn 边界不构成风险消散边界。

**世代切换语义**：

| 触发                                     | 账本处理                                                                                                      | 审计                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 新 session 创建                          | 新世代，账本从空开始                                                                                          | `generation-switch{reason: session-created}`                              |
| **用户显式 flush**                 | **唯一清账路径**；UI 必须呈现为安全决策（「重置数据流账」）                                             | `generation-switch{reason: user, cleared: true}`                          |
| **自动压缩（context compaction）** | **必须继承账本**——默认继承**完整事件集**（label + source + stepId）；最小部署档可降级为布尔摘要 | `generation-switch{reason: auto-compaction, inherited: 'full'\|'summary'}` |
| 上下文销毁                               | 账本归档入审计（不删除）                                                                                      | `generation-switch{reason: context-destroyed, archived: true}`            |

**继承粒度**：

- **完整事件集（默认）**：新世代账本初始状态 = 原世代所有 ≥sensitive 读事件的完整记录（label + source + stepId）。审批摘要与归因可直接引用来源。
- **布尔摘要（最小部署档降级）**：仅记录 ≥sensitive 读的布尔标记；审批摘要明确标注归因弱化——部署档显式选择，审计一等事件。

**为什么自动压缩必须继承**：压缩是模型可通过「产生大量输出逼近上限」自主诱导的事件。若压缩清账本，则形成一条被注入指令可驱动的**账本清洗攻击路径**。继承账本堵死此路径。这符合 P19 与 P13。

**世代级 egress 确认（A2 修正后）**：

| 项                            | 内容                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发                          | 世代继承后，条件破缺的 egress 调用进入审批                                                                                                                                                          |
| 审批人选项                    | ① 单次允许；②**签署世代级知情豁免**；③ 拒绝                                                                                                                                                |
| **知情豁免文案（A2b）** | 必须含：「本世代已发生**N 次 sensitive 读**（来源列表：…）；工作区存在 **M 个 derived-label 文件**（列表：…）；签署后本世代 egress 将静默」——**审批人有权知情，不做虚假声明** |
| **失效判定（A2a）**     | 确认记录签署时的`ledgerVersion`；**有效性 ⟺ 当前账本版本前缀中无晚于该版本的 ≥sensitive 读事件**。裁决时**同步计算**，不依赖异步监听——消除「失效事件已入账、传播未完成」的窗口    |
| 签署后效果                    | 本世代内后续 egress 调用在条件破缺时**静默放行**（仍记审计）；摩擦点从「清上下文」精确化为「知情豁免」                                                                                        |
| 审计                          | `generation-egress-attestation{attestor, generationId, ledgerVersion, timestamp, scope}`                                                                                                          |

**为什么不能用「我确认本世代无敏感残留」**：触发确认的恰是账本里的敏感读——签署时刻该声明即为假。改为知情豁免表述，把真实状态告诉审批人，由其判断。

#### 1.3.4 守恒律与摩擦分配

```
泄漏风险 = source 可达性 × sink 可达性
治理 = 在两端之间分配摩擦：
  · sink 端设卡     → source 自由，每次出网都疼（全对守卫、出站检查）
  · source 端设卡   → sink 自由，每次读都疼（敏感读恒 gated）
  · 源头断流        → 在 source 处一次性付清摩擦，此后两端同时放松（SecretRef）
  · 条件预授权      → 摩擦延迟到「实际共现」时刻支付：未使用不疼，使用即疼
  · 世代级知情豁免  → 摩擦从「清记忆」精确化为「知情豁免」，注入者无从诱导
```

**断流兑现（A1a 修正）**：断流读的原文从未进入上下文，后续写不可能包含该内容——断流读**不产生 overlay 污染**。守恒律对断流的承诺「付清摩擦后两端同时放松」被完整兑现，系统不惩罚自己最好的防御行为。

三问生成六规则，六规则生成全部档位与钳制。**规则的完备性由公理保证，不由枚举保证。**

### 1.4 语义边界

三问公理与六规则覆盖**效果权限风险**（资源效果与数据流的治理）。以下风险域不在生成完备范围，各有独立治理面——本系统仅承担下表「本系统承担」列：

| 风险域                   | 治理面                                                       | 本系统承担                           |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------ |
| DoS / 资源耗尽           | 预算（管线⑧）、Turn 预算即 task 预算                        | 独立面                               |
| 内容层注入               | untrusted 标 + 数据不作为指令                                | 爆炸半径压缩，非免疫                 |
| 供应链（依赖投毒）       | external.* R4 + 边界集钩子（R5）                             | 部分缓解                             |
| 审批人欺骗               | 审批回显义务、数据流/交易摘要、**知情豁免文案（A2b）** | 部分缓解（人的判断质量不属系统承诺） |
| 侧信道                   | 不覆盖                                                       | 无                                   |
| 完整性破坏（非边界资产） | R1/R6 可逆性                                                 | 部分缓解                             |

**多委托人界定**：本设计默认**单委托人**（single principal）——即同一 session 内所有上下文产物归属同一授权主体。`chat` 输出在多委托人场景下**视为 egress sink**，受 R2 与 R3-flow 约束。多委托人共享上下文属于未覆盖风险域，需独立治理面（消息隔离 / 委托边界）。

**账本追踪边界**：本系统追踪**上下文残留**与**工作区数据残留**（§6.8 derived label overlay）两个风险面。**显式持久化到系统外部的敏感数据**（如用户手动导出的文件、Agent 调用的外部服务返回并落盘的数据）不在账本覆盖内——**最终边界始终是源头断流**。

### 1.5 术语

| 术语                       | 定义                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Domain 域**        | 坐标系：`sandbox / workspace / host / external`                                                                                                                                     |
| **Label 标**         | 资产敏度标注：`public / internal / sensitive / secret`，统一适用于路径、db 表、host、环境变量等                                                                                     |
| **负例条目（v1.3）** | 平台策展的高 specificity known-safe pattern，用于收窄过宽的内置标注（如`**/*.pub` 收窄 `**/*.pem`）                                                                               |
| **Derived Label**    | 由数据流派生的叠加标注：写操作在账本含**未断流** ≥sensitive 读时，对目标路径施加敏感叠加标签；**上限 sensitive**                                                         |
| **Role 角色**        | 操作三轴声明：`transfer × commit × opacity`；commit 声明须有可逆凭据背书                                                                                                          |
| **可逆凭据**         | 可逆性的执行机制背书：`domain-teardown`（整域销毁）或 `task-scratch`（task 域受管暂存区，Turn 结束销毁）；凭据缺失则 R6 不生效                                                    |
| **上下文世代**       | 模型上下文生命周期单元（§1.3.3）；数据流账的默认记账域                                                                                                                               |
| **世代切换**         | 世代边界的迁移事件；触发原因分为 user / auto-compaction / session-created / context-destroyed；审计一等事件                                                                           |
| **世代级知情豁免**   | 审批人签署的世代级确认；含敏感读次数、来源列表、derived-label 文件数；签署后本世代 egress 静默；**同步失效判定**（ledgerVersion 前缀无新敏感读）                                |
| **条件预授权**       | R3-flow 产物：附加在 effective 快照 sink 上的运行时谓词（本世代账本无 ≥sensitive 读），非 grant 变更                                                                                 |
| **句柄绑定**         | SecretRef 创建时固化的`allowedSinks` 白名单与用途；解析能力由此决定，不由请求决定                                                                                                   |
| **签名策略**         | `purpose` 的结构化形式：`(service, action, resourcePattern, conditions)`；代签器校验满足后才构造签名串                                                                            |
| **句柄代签**         | SecretRef 解析一级：网关以绑定凭据对**经策略校验的**请求代签；**代签器从结构化 invocation 构造请求并签名；handler 永不接触 wire format**                                  |
| **短时能力令牌**     | SecretRef 解析二级：向 sanctioned sink 签发短 TTL、窄范围、可撤销的能力令牌                                                                                                           |
| **行为签名**         | 工具调用的可计算特征向量（域、效果类、目标分布、args 结构、频次、数据流方向），用于信任阶梯升降级判据                                                                                 |
| **信任阶梯**         | 外部工具 T0→T1→T2 分级：收容消解不透明性，升级仅根层签署                                                                                                                            |
| **TCB**              | 可信计算基：标注注册表、角色声明、规则求值器、Deployer、句柄解析/代签器、egress proxy、数据流账、动词匹配器、条件裁决器、账本版本管理器、derived label overlay 管理器、根信任锚客户端 |
| **根信任锚**         | 根层签名公钥、审批人身份源、审计日志外部锚、策略撤销注册表——TCB 之根，位于 TCB 之外                                                                                                 |
| **CapabilityKey**    | `action.domain` 字符串化（如 `fs.write.sandbox`）                                                                                                                                 |
| **规则优先序**       | hard 层 > R 系下限 > meet 结果                                                                                                                                                        |
| **ruleHit**          | 一次钳制/条件附加的审计记录：规则 id × 能力 × 来源版本                                                                                                                              |
| **数据流账**         | 上下文世代域的敏感输出标签记录（label / source / stepId / ledgerVersion）                                                                                                             |
| **SecretRef**        | 敏感输出句柄：模型只见句柄；仅在其绑定白名单内由代签器 / 令牌签发器 / Deployer 注入解析原文                                                                                           |

---

## 2. 设计原则

| #                     | 原则                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1                    | 授权只发生于根层；`full-access` 永不出现在派生路径                                                                                                                                               |
| P2                    | 任务层只有请求权，数据结构上无法表达授予                                                                                                                                                           |
| P3                    | effective 是计算值：tier = meet(各层意愿) ⊔ 规则下限；条件预授权作为快照成分一同计算，无持久化可编辑形态                                                                                          |
| P4                    | 三档制 + 范围白名单预授权；确认按不可逆性收费                                                                                                                                                      |
| P5                    | 权威链是合取（meet），任何层只能收紧；规则下限在 meet 之外；hard 层在下限之外                                                                                                                      |
| P6                    | 提示不是安全边界，内核强制才是；**内核保证无旁路，不保证策略无误**——策略正确性由 TCB 治理承担，TCB 之根由根信任锚承担                                                                      |
| P7                    | fail-closed：沙盒 / 审批 / 代理 / secrets / 账本缺件即拒绝                                                                                                                                         |
| P8                    | 经验主义优先：默认 on-failure 触发升权，不要求模型先知                                                                                                                                             |
| P9                    | 模型可见的与审计记录的是同一份状态                                                                                                                                                                 |
| P10                   | 高危与档位无关：R 系下限在任何配置下生效，full-access 亦不豁免                                                                                                                                     |
| P11                   | 并发不削检查：并行 Steps 带来并发调用，每次独立过管线                                                                                                                                              |
| P12                   | 数据流纪律：call-scoped 强制由「源头断流 + 出站检查 + 条件预授权」补全为 flow-aware；组合风险按运行时数据流判定                                                                                    |
| P13                   | 标注 fail-safe：未标注资产 =`internal`；标注存疑 = `sensitive`；保守方向不可配置关闭                                                                                                           |
| P14                   | 摩擦按实际使用征收：能力被授予而未使用不产生审批摩擦；共现事实发生时在正确的时刻支付                                                                                                               |
| P15                   | 账本域绑定上下文世代：敏感内容残留风险延续到上下文销毁                                                                                                                                             |
| P16                   | 并发账本线性化：数据流账具备版本号与全序提交点；裁决读必须读同一账本版本                                                                                                                           |
| P17                   | 解析最小暴露：SecretRef 默认经代签 / 短时令牌解析，原文进入 handler 仅限受限兼容路径                                                                                                               |
| P18                   | 根信任可验证：根层签署、审批人身份、审计完整性、策略撤销由独立锚支撑；TCB 不能自证                                                                                                                 |
| P19                   | 世代切换保守继承：自动压缩触发的世代切换继承账本；只有用户显式 flush 清账本；保守方向不可配置关闭                                                                                                  |
| P20                   | 强制缺口必须披露：不可强制的轴要么 forbidden（无强制即无执行），要么 gated + 强制披露                                                                                                              |
| P21                   | **解析器语义一致性**：所有跨边界解析（wire format 构造、路径 realpath、canonical form）必须在 TCB 内完成规范化，禁止将规范化责任下推给对端；代签器构造 wire format，handler 永不接触请求原文 |
| P22                   | **数据残留追踪**：账本含**未断流** ≥sensitive 读时的写操作，对目标路径施加 derived label（**上限 sensitive**）；数据残留与上下文残留同属追踪范围                                |
| P23                   | **摩擦逃逸阀消除**：世代继承摩擦由「世代级知情豁免」精确化，不诱导用户清上下文                                                                                                               |
| **P24（v1.3）** | **overlay 分层边界**：derived label 是会话级保守近似，**只收紧 flow 层，不驱动 hard 层**；hard 层只由静态标注触发                                                                      |
| **P25（v1.3）** | **断流兑现**：断流读不产生 overlay——系统不惩罚自己最好的防御行为                                                                                                                           |
| **P26（v1.3）** | **安全决策解耦**：overlay 清除与 flush 是两个独立的一等安全决策；UI 逐文件确认，不批量静默                                                                                                   |

---

## 3. 体系结构

```
                    ┌─────────────────────────────────────────┐
                    │  根信任锚（TCB 之外/之上）                │
                    │  根签名公钥 · 审批人身份源 · 审计外部锚    │
                    │  策略撤销注册表                            │
                    └────────────────┬────────────────────────┘
                                     │ 签署 / 撤销 / 锚定
                                     ▼
GrantStore(根层签署) ──► PolicyResolver(派生) ──► ToolGateway(执行咽喉)
     │ 一次                  │ 每契约一次                │ 每次调用
     ▼                       ▼                          ▼
  AgentGrant        ① meet(意愿)                11 阶段管线
                 ② 角色下限 R1/R2/R4/R6          ⑤ 值层范围 + 出站检查
                 ③ 边界标注 R5                      + R3-flow 条件裁决(账本v)
                 ④ 全对守卫 R3(hard/flow)         ⑦ 审批 seam
                 ⑤ hard 层钳制(V17)              ⑨ 沙盒执行 + 代签器构造wire请求
                 ⑥ 后端封顶 V15                   ⑩ 打标/断流 + 数据流账(v+1)
                    → EffectivePolicy + ruleHits     + derived label overlay(上限sensitive)
                      + conditions
旁轨: DecisionLog(签名链) · Budget Meter · Approval Seam · Kill Switch(格之外)
底部: 标注注册表(TCB) · 沙盒后端(Landlock/Seatbelt) · Egress Proxy
      · 数据流账(版本化) · SecretRef 代签器(策略校验+wire构造) · 根信任锚客户端
      · Derived Label Overlay 管理器
```

**三层时间尺度**：

- **根层**（一次）：签署 `AgentGrant`；`full-access` 只在此层存在。
- **派生层**（每契约一次）：`PolicyResolver` 求值链，输出 `EffectivePolicy` 快照，钉住 TCB 版本与根信任版本。
- **执行层**（每次调用）：`ToolGateway` 11 阶段管线，读账本版本、写账本新版本、在 ⑩ 施加 derived label。

---

## 4. 权限模型

### 4.1 Domain 域

```typescript
export type Domain = 'sandbox' | 'workspace' | 'host' | 'external';
```

域是坐标系，不是动词分类。`fs.write.sandbox` 之所以无害，不是动词温和，而是域属性使三问皆否。

**draft 不是域**——它是 workspace 内 task 受管暂存区的限定词，作为可逆凭据表达（R6）。

### 4.2 Label 标

```typescript
export type SensitivityLabel = 'public' | 'internal' | 'sensitive' | 'secret';
export interface AssetLabel {
  kind: 'path' | 'db' | 'host' | 'env' | 'registry' | 'topic';
  pattern: string;              // glob / FQN / 域名通配
  label: SensitivityLabel;
  boundary?: boolean;           // 权限包络资产 → R5
  specificity?: number;         // pattern 具体度（非通配字符数），用于冲突裁决
  origin: 'platform' | 'user' | 'platform-curated-negative';  // v1.3：负例条目
}

// Derived label overlay（v1.3 修正三轴）
export interface DerivedLabel {
  target: string;               // 绝对路径 / FQN（realpath 规范化后）
  label: 'sensitive';           // 上限 sensitive（A1b）
  derivedFrom: string[];        // 未断流 ≥sensitive 读的账本事件 id
  lifetime: 'manual-clear' | 'sandbox-teardown';  // workspace 默认 manual-clear；sandbox/draft 随域销毁
  createdAt: LedgerVersion;
}
```

统一标注层覆盖路径、db 表、host、环境变量、注册表、消息主题等全部资产类型。内置标注（用户可追加）：

| 类别     | 资产示例                                                                                            | Label                                | 备注                                                               |
| -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| 秘密     | `~/.ssh/**`、`**/.env`、`**/*.pem`、`**/id_rsa*`、`**/credentials*`、钥匙串、凭据环境变量 | `secret`                           | 读必断流（R3-hard）；**写 forbidden 无例外（V17，hard 层）** |
| 系统配置 | `/etc/**`、`/usr/**`、`/bin/**`、`/System/**`、注册表                                       | `sensitive`                        | 关键项另标 boundary → R5                                          |
| 用户数据 | workspace 之外的家目录                                                                              | `sensitive`                        | 显式授予才可达                                                     |
| 边界集   | 见 §7.3                                                                                            | 按资产分别`secret` / `sensitive` | `boundary: true`                                                 |

**负例条目（B1）**：平台策展一批**高 specificity known-safe pattern**，用于收窄过宽的内置标注：

| 过宽内置       | 负例条目（更高 specificity）                                  | 效果                    |
| -------------- | ------------------------------------------------------------- | ----------------------- |
| `**/*.pem`   | `**/*.pub.pem`、`**/ca-certificates/**`、`**/chain.pem` | 公钥证书不再命中 secret |
| `**/.env*`   | `**/.env.example`、`**/.env.template`、`**/.env.sample` | 模板文件不再命中 secret |
| `**/id_rsa*` | `**/id_rsa.pub`                                             | 公钥不再命中 secret     |

**负例条目是 N15 压制的合法出口（B2）**：当前 secret 降级只走双人 ContractRevision，对「读个模板」成本荒谬，用户的实际出路是改名绕 pattern——**压制 + 无低成本出口 = 影子路径生成器**。负例条目由平台策展、走 T3 全量回归，提供低成本且经审计的出口。

**模式冲突裁决（v1.3 更新）**：

1. **secret 级平台强制不可降级**：任何内置 secret 标注**优先于用户声明**。用户对 secret 资产的降级声明被压制，审计 `label-resolution{reason: 'user-downgrade-suppressed', asset, userLabel, enforcedLabel}`。**但**——若该资产命中平台策展负例条目，按负例条目标注处理（走 T3，不走用户声明）。
2. **sensitive 及以下：取最严 Label，同 Label 下更具体 pattern 优先，用户显式声明优先于平台内置**。
3. **boundary 属性取并集**（任一命中即 boundary）。
4. **secret 降级路径**：① 平台策展负例条目（低成本）；② 根层 `ContractRevision`（高成本，双人签署）。

**压制聚合呈现（B3）**：`label-resolution` 压制事件**聚合呈现**给用户——「你的 3 条标注未生效（列表）」。否则压制审计只是装饰，用户无从得知自己的标注没生效。

**标注缺省方向（P13）**：未标注 = `internal`；存疑 = `sensitive`。保守方向不可配置关闭。

### 4.3 Role 角色

```typescript
export type Transfer = 'none' | 'ingest' | 'egress';
export type Commit   = 'reversible' | 'recoverable' | 'committed';
export type Opacity  = 'transparent' | 'opaque';
export type ReversibilityEvidence = 'domain-teardown' | 'task-scratch';

export interface Role {
  transfer: Transfer;
  commit: Commit;
  opacity: Opacity;
  reversibleBy?: ReversibilityEvidence;
}
```

Role 由工具注册时声明。内置工具由平台背书并随注册签名入 TCB；外部工具一律按 opaque 处理（§4.6 阶梯治理）。

**`commit: reversible` 是声明与凭据的合取**——凭据是 Deployer 可执行的机制，不是承诺：

| 凭据                | 语义                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `domain-teardown` | 整域销毁——沙箱整体销毁即撤销全部后果                                      |
| `task-scratch`    | task 域受管暂存命名空间（`fs.write.draft` 的真实语义），Turn 结束强制销毁 |

凭据不被后端能力矩阵支持（V15）→ 按 `recoverable` 处理。

### 4.4 六条派生规则

| #            | 触发条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 效果                                                                                                    | 对应三问     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| **R1** | `role.commit = committed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | tier 下限 gated，白名单不豁免                                                                           | Q1           |
| **R2** | `role.transfer = egress`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | tier 下限 gated；预授权仅限结构化范围（hosts / amountLimit）                                            | Q1′         |
| **R3** | effective 内存在 source 可达`≥sensitive` ∧ sink `transfer=egress` ∧ sink 未断流。**两级执行**：**R3-hard（secret 级）**：静态钳制 sink 至 gated；secret source 必须断流（句柄化）否则 forbidden——无任何条件豁免。**R3-flow（sensitive 级）**：不降 sink tier，向快照内 sink 附加**条件预授权**谓词 `本世代账本无 ≥sensitive 读`；调用时对照数据流账裁决——条件成立 → 结构化范围内静默放行；破缺 → 转审批（带数据流摘要）/ 世代级知情豁免。条件属快照成分，**不回写 grant** | Q2                                                                                                      |              |
| **R4** | `role.opacity = opaque`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 按最坏角色（committed + egress）计算下限 + 每次调用一等风险事件；消解路径见信任阶梯（§4.6）            | 三问不可回答 |
| **R5** | 目标资产`boundary=true` 的**写**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | tier 下限 gated +`boundary-write` 事件；**若目标 Label = secret → V17 hard 层优先，forbidden** | Q3           |
| **R6** | `role.commit = reversible ∧ reversibleBy 凭据成立 ∧ 凭据被后端支持`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 允许 auto；前提注记：可撤销性以凭据机制真实执行为条件                                                   | 三问皆否     |

**钳制次序**：R1/R2/R4/R6 逐能力求值下限 → R5 边界标注 → R3 全对（hard 钳制 / flow 条件附加）→ hard 层（V17）终裁 → 后端封顶（V15）。下限与 hard 层永不参与 meet（V8）。

### 4.5 规则优先序（v1.3 显式分层）

同一操作命中多层判定时，按以下优先序取**最严结果**：

```
hard 层（不可豁免，任何配置生效；只由静态标注触发——P24）
  V17: secret 写 = forbidden
  V13: fail-closed
    ▲ 不参与
  derived label overlay（上限 sensitive，只收紧 flow 层——A1b）
    ▲ 不参与
规则下限层（R1–R6，不参与 meet）
  如 R5: boundary 写下限 gated
      R3-hard: sink 钳制
      R3-flow: 条件附加（含 overlay 触发的破缺）
    ▼ 覆盖
meet 层（各层意愿合取）
```

**显式分层（P24）**：derived label overlay **上限 sensitive**，**只收紧 flow 层**（条件破缺 / 审批 / 出站检查）；**不驱动 hard 层**。hard 层只由静态标注触发。

**为什么 overlay 不接入 hard 层**：derived label 是会话级布尔的保守近似，不该接入设计上「精确无例外」的 hard 层。走查（若无此限制）：读敏感数据 → 写 report.txt → overlay=secret → 更新报告 forbidden、读报告句柄化、delete 走 R1 gated——正常工作流被拖进 hard 层僵局。

**判定示例**：

| 操作                                                      | 命中                                                   | 优先序结果                                       |
| --------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| 写`~/.ssh/authorized_keys`                              | R5（boundary → gated）+ V17（secret 写 → forbidden） | **forbidden**（V17 优先）                  |
| 写 crontab                                                | R5（sensitive ∧ boundary）                            | **gated + boundary-write 事件**            |
| 写`~/.ssh/config`                                       | V17（secret 写）                                       | **forbidden**                              |
| **写 derived-label=sensitive 的 report.txt（A1b）** | **overlay 只收紧 flow 层**                       | **按静态标注路径处理；overlay 不触发 V17** |

**优先序是实现与测试的验收基线**：全规则 × 全标注 × 全档位矩阵单测必须断言优先序。

### 4.6 外部工具信任阶梯

R4 全量最坏角色在长期运行中制造审批疲劳（每次 gated + 每次风险事件）。消解路径是**收容与审计**，不是提示或声明。

#### 4.6.1 阶段定义

| 阶段                      | 进入条件                                                                                         | R4 效应                                                                                                    | 审计                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **T0 试用**（默认） | 新注册外部工具                                                                                   | opaque 生效：最坏角色下限 gated                                                                            | 每次调用`full-trust-invocation` 事件 |
| **T1 受限收容**     | 根层签署收容配置：沙盒 profile（fs/net jail）+ egress proxy 白名单 +`untrustedOutput` 保持默认 | **收容消解不透明性**：效果面由沙盒实测背书而非声明信任，下限从最坏角色降为「声明角色 ∧ 实测强制面」 | 事件降频为抽样 + 首次新行为签名事件    |
| **T2 资深**         | 试用期审计窗口零 danger/boundary 事件 + 行为签名稳定                                             | 根层签署预设提升；auto 仅限 read 类 + 结构化范围                                                           | 异常行为签名即降级                     |

#### 4.6.2 行为签名形式化

**签名向量**：

```
σ(call) = ⟨domain, effectClass, targetBucket, argShape, transferDir, frequency, verdictPath⟩
```

| 分量             | 取值                                                    | 说明                                  |
| ---------------- | ------------------------------------------------------- | ------------------------------------- |
| `domain`       | 四值枚举                                                | sandbox / workspace / host / external |
| `effectClass`  | 有限枚举 + 前缀哈希                                     | 落 O(1) 索引                          |
| `targetBucket` | 目标资产的粗粒度桶（路径前缀 / 域名 eTLD+1 / 表名前缀） | 避免逐值噪声                          |
| `argShape`     | args 结构指纹（键集合 + 类型树 + 长度分桶）             | 不存原文                              |
| `transferDir`  | none / ingest / egress                                  | 数据流方向                            |
| `frequency`    | 滑动窗口计数分桶                                        | 防低频突增                            |
| `verdictPath`  | auto / gated / approval / forbidden                     | 判定路径                              |

**稳定性判据**：在审计窗口 `W = max(N 次调用, M 天)` 内：

- **小样本期（`callCount < N_min`，默认 `N_min = 200`）**：使用**集合比较**替代分布距离——断言 `targetBucket` 集合无新增、`effectClass` 集合无新增、`verdictPath` 集合无新增；避免 KL 估计噪声；
- **充足样本期**：`σ` 的分布漂移 `D_KL(σ_window ‖ σ_baseline) < τ_kl`；
- 无 `forbidden` / `boundary-write` / `danger-verb` 事件；
- `verdictPath` 中 `auto` 占比稳定且与声明角色一致。

**防慢速投毒**：窗口 `W` 采用指数衰减 + 硬上限；`τ_kl` 随工具年龄单调不增（老工具更严）；每季度强制重基线；工具跨版本升级视为新工具回落 T0。

**降级判据**：任一窗口内稳定性判据破缺，或出现任何 danger/boundary 事件，或收容配置失效（后端不支持，V15）→ **即时回落 T0**，全量事件恢复。

#### 4.6.3 阶梯纪律

- 阶梯**只消解不确定性惩罚**（R4 的 opaque 加罚），**永不触碰 R1/R2 下限**——committed / egress 效果在任何阶段仍 gated；
- 一切升级 = 根层人工签署 + ContractRevision；**提示、模型请求、工具自述永不触发**；
- 降级即时；
- `full-trust-invocation` 事件率是审批疲劳的度量指标——阶梯的动机即在此，手段是收容与审计，不是放宽检查。

### 4.7 验算

| 操作                         | 三原语判定 → 规则路径                         | 结论                                      |
| ---------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `fs.write` 沙箱临时文件    | reversible @ sandbox +`domain-teardown` 凭据 | R6 → auto                                |
| `fs.write` draft 暂存区    | reversible @ workspace +`task-scratch` 凭据  | R6 → auto；Turn 结束强制销毁             |
| `fs.read ~/.ssh/id_rsa`    | Label: secret，source                          | R3-hard：断流或 forbidden                 |
| 写`~/.ssh/authorized_keys` | secret ∧ boundary                             | **V17 hard 优先于 R5 → forbidden** |
| 写 crontab                   | sensitive ∧ boundary                          | R5 → gated + boundary-write              |

---

## 5. 授予与派生

### 5.1 根层授予与任务层请求

```typescript
export interface CapabilityRule {
  action: Action;
  domain: Domain;
  tier: EffectTier;                  // 意愿档位（参与 meet；生效档 ≥ 规则下限）
  trigger?: 'on-failure' | 'on-request';
  paths?: string[];                  // glob 方言，语义由单测固定
  hosts?: string[];
  amountLimit?: Money;               // 仅 pay
  maxLabel?: SensitivityLabel;       // 可触达最高敏度（缺省 internal——P13）
  scope?: 'task-scratch';            // draft 限定词（配合可逆凭据）
}

export type AgentGrant = Partial<Record<string, CapabilityRule>> & {
  budget?: { steps?: number; tokens?: number; cost?: number };
};

export const PRESETS = {
  'read-only':       { 'fs.read.workspace': { tier: 'auto', maxLabel: 'internal' } },
  'workspace':       { 'fs.read.workspace': { tier: 'auto' },
                       'fs.write.sandbox':  { tier: 'auto' },
                       'fs.write.draft':    { tier: 'auto', scope: 'task-scratch' } },
  'workspace-write': { 'fs.read.workspace': { tier: 'auto' },
                       'fs.write.workspace':{ tier: 'auto' } },
} satisfies Record<string, AgentGrant>;

// 仅根层可调用（P1）；full-access 不豁免 R 系下限与 hard 层（P10）
export function fullAccessGrant(rootContractId: ContractId): AgentGrant;

export interface TaskPolicyRequest {
  requires: CapabilityKey[];
  wants?: Partial<Record<string, CapabilityRule>>;
}
```

**PRESETS 覆盖目标**：预设应覆盖 90% 常见任务；未覆盖的任务类型应作为 telemetry 信号反馈到预设演进，减少用户从零构造宽授权的动机。

### 5.2 meet 语义

| 轴                          | 规则                                               |
| --------------------------- | -------------------------------------------------- |
| tier                        | 取严者；R 系下限与 hard 层在 meet 之后强制钳制     |
| trigger                     | 取更保守者                                         |
| paths / hosts / amountLimit | 集合交；amountLimit 取较小者；`undefined` 为顶元 |
| maxLabel                    | 取更严者                                           |
| 未声明能力                  | `forbidden`（closed-world，V5）                  |

### 5.3 派生流程

```
derive(parent, request):
 1. requires 逐项对照父层, forbidden → fail-fast 发起 ContractRevision(不 spawn)
 2. wants ∧ parent meet（tier / 范围 / maxLabel，§5.2）
 3. 角色下限：逐能力求值 R1 / R2 / R4 / R6（R6 校验可逆凭据与后端支持）
 4. 边界标注：effective 可达的 boundary 资产 → 写能力套 R5 下限
 5. 全对守卫（§5.4）：R3-hard 钳制 / R3-flow 条件附加
 6. hard 层终裁：V17（secret 写 forbidden）、V13
 7. 后端能力封顶（V15）
 8. 快照 EffectivePolicy {
      derivedFrom, ruleHits[], conditions[],
      pinned: { labels@v, roles@v, rules@v, rootTrust@v },
      ledgerDomain: 'context-generation' | 'session'
    }
    —— 每次钳制/条件附加记 ruleHit；快照钉住 TCB 与根信任版本
```

**子层变宽的唯一路径是人**：ContractRevision → 根授权 v+1 → 重派生。派生时收敛完毕，运行时无策略级惊喜——R3-flow 条件的**裁决**在运行时，条件**本身**派生时已定。

### 5.4 全对守卫

派生时对 effective 中每对 `(source, sink)` 求值，按 source 敏度分级处置：

| source 敏度    | 处置                                                                               | 摩擦时点                 |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| `secret`     | **R3-hard**：sink 钳制 gated（白名单不豁免）；source 无断流声明 → forbidden | 派生时，无豁免           |
| `sensitive`  | **R3-flow**：sink 保持 meet 档，附加条件预授权谓词；调用时账本裁决           | 实际共现时，未使用零摩擦 |
| `≤internal` | 无守卫                                                                             | —                       |

- 条件预授权**是快照成分**：随 effective 一起计算、审计、版本化，**不回写 grant**、不可被模型面触发或撤销（P14/N5）；
- 账本域默认**上下文世代**；高敏感部署可配置为 Session 域（更保守，更多摩擦）；
- `strict` 部署档可要求 sensitive 亦走 R3-hard 静态钳制——该选择属根层授权面；
- 新效果类、新工具、新资产类型接入时，全对自动覆盖——零新规则。

### 5.5 值层与行为面

调用时强制行为（11 阶段管线、范围投影、动词匹配、审批、沙盒执行、打标）由 ToolGateway 定义。两层检查缺一不可：

- **派生时**算策略层：范围∩范围 + R 系下限 + 条件附加；
- **调用时**算值层：本次值落域、命中标注、命中动词、账本裁决条件、derived label 检查（flow 层）。

---

## 6. 数据流治理

### 6.1 粒度错配声明

管线各阶段按**单次调用**判定（call-scoped），泄漏按**数据流**发生（flow-scoped）：`fs.read` 与 `net.send` 各自可合规放行，组合构成外泄通道——上下文枢纽即转运介质。危险组合不可静态枚举（「本世代读过什么」是运行时事实），故机制分三层 + 条件预授权 + derived label overlay。

**账本域 = 上下文世代 + 工作区 derived label**：Turn1 读 sensitive、Turn2 出站（同世代）仍判为共现；写入工作区的内容被施加 derived label，跨 Session 可追踪（manual-clear）。

### 6.2 三层防线 + 条件裁决

| 层                                                   | 机制                                                                                                                                                                         | 性质                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **源头断流**（首选；R3-hard 强制于 secret 级） | 敏感源声明`outputSensitivity`；输出不返回原文——redaction 或 **SecretRef 句柄化**。secrets 不入 args，也**不入 outputs**                                      | 结构性——模型无从泄漏其未见之物；**断流读不产生 overlay（P25）** |
| **条件预授权裁决**（R3-flow 执行点）           | 对带条件的 sink 对照**数据流账（指定版本 `ledgerVersion`）**：条件成立 → 结构化范围内静默；破缺 → 转审批（带数据流摘要）/ 世代级知情豁免 / 拒 `EGRESS_SENSITIVE` | 摩擦延迟到共现时刻；账本域 = 上下文世代                                 |
| **出站检查**（兜底）                           | `dataEgress: true` 工具附带：**同一账本版本**对照 + args 值投影内容探测。命中 → 审批或拒                                                                            | 检测性纵深                                                              |
| **审计信号**                                   | 「敏感读 → 出站」模式一等信号；账本支持回放「载荷来自哪次读」                                                                                                               | 事后归因与调优                                                          |

**账本生命周期**：

| 事件                     | 账本处理                                                                                        | 审计                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 新 session 创建          | 新世代，账本从空开始                                                                            | `generation-switch{reason: session-created}`                              |
| **用户显式 flush** | **唯一清账路径**；UI 呈现为安全决策「重置数据流账」；**与 overlay 清除解耦（P26）** | `generation-switch{reason: user, cleared: true}`                          |
| **自动压缩**       | **必须继承账本**——默认完整事件集；最小部署档降级为布尔摘要                              | `generation-switch{reason: auto-compaction, inherited: 'full'\|'summary'}` |
| 上下文销毁               | 账本归档入审计（不删除）                                                                        | `generation-switch{reason: context-destroyed, archived: true}`            |

**继承语义**：

- **完整事件集（默认）**：新世代账本初始状态 = 原世代所有 ≥sensitive 读事件的完整记录。审批摘要与归因可直接引用来源。
- **布尔摘要（最小部署档降级）**：仅记录 ≥sensitive 读的布尔标记；审批摘要明确标注归因弱化。
- 条件预授权谓词在新世代继续对继承事件敏感：只要继承事件存在，`net.send` 仍判为破缺。

**世代级知情豁免（A2 修正后）**：

| 项                            | 内容                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发                          | 世代继承后，条件破缺的 egress 调用进入审批                                                                                                                |
| 审批人选项                    | ① 单次允许；②**签署世代级知情豁免**；③ 拒绝                                                                                                      |
| **知情豁免文案（A2b）** | 必须含：「本世代已发生**N 次 sensitive 读**（来源列表：…）；工作区存在 **M 个 derived-label 文件**（列表：…）；签署后本世代 egress 将静默」 |
| **失效判定（A2a）**     | 确认记录签署时的`ledgerVersion`；**有效性 ⟺ 当前账本版本前缀中无晚于该版本的 ≥sensitive 读事件**。裁决时**同步计算**，不依赖异步监听      |
| 签署后效果                    | 本世代内后续 egress 调用在条件破缺时**静默放行**（仍记审计）                                                                                        |
| 审计                          | `generation-egress-attestation{attestor, generationId, ledgerVersion, timestamp, scope}`                                                                |

### 6.3 SecretRef 句柄绑定与解析

若 egress 工具可随意解析句柄，断流即失效——「原文不进枢纽」会被「句柄进枢纽、出站再解析」绕过。解析路径分为**三级阶梯**，默认走最保守路径。

#### 6.3.1 三级解析阶梯

| 级别                                       | 机制                                                                                                                | 原文进入 handler？ | 适用                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| **L1 网关代签**（默认）              | **代签器从结构化 invocation 构造 wire format 并签名**；handler 收到**已签名请求**，不含原文             | 否                 | 支持代签的协议（AWS / GCP / OAuth2 / 部分 HTTP） |
| **L2 短时能力令牌**                  | 网关签发**短 TTL（默认 ≤60s）、窄范围、可撤销**的能力令牌，注入 handler 环境；令牌仅对 `allowedSinks` 生效 | 否（令牌非原文）   | 支持 bearer / capability token 的协议            |
| **L3 Deployer 原文注入**（受限兼容） | 仅当`tool ∈ ref.allowedSinks` 且 sanctioned channel 存在，原文注入 handler 进程内存                              | 是                 | 不支持 L1/L2 的遗留协议                          |

**选择规则**：注册时声明工具支持的最高级别；运行时按「L1 > L2 > L3」取可用最高。若工具仅支持 L3，注册时须根层签署「L3 例外」并在审计中记 `handle-inject-origin` 一等事件。

#### 6.3.2 L1 代签的签名策略

**问题**：若 handler 构造 HTTP 请求、代签器只完成签名步骤，则代签器是在**盲签 handler 的任意请求**——canonical form 攻击面：注入的 handler 构造一个 canonical 形式匹配 `my-bucket/*`、服务端解码后指向其他 bucket 的请求——策略校验通过，签名生效，越权发生。

**修复（构造者语义写死）**：

> **代签器从结构化 invocation 构造请求并签名；handler 永不接触 wire format。**

```
# handler 提交的 invocation（结构化，无 wire format）
Invocation {
  tool: string,
  service: string,       # 's3' | 'ec2' | 'sts' | ...
  action: string,        # 'GetObject' | 'ListBucket' | ...
  target: string,        # 资源标识（ARN / URL 结构，非 wire）
  body: bytes | SecretRef | inline,
  headers: { key: value },   # 结构化 header，非原始字节
}

# 代签器流程（P21：规范化责任在 TCB 内）
gatewaySign(ref, invocation):
  1. assert invocation.tool ∈ ref.allowedSinks else Reject(HANDLE_REFUSED)
  2. assert invocation.service ∈ ref.purpose.service else Reject(SIGN_POLICY_VIOLATION)
  3. assert invocation.action ∈ ref.purpose.actions else Reject(SIGN_POLICY_VIOLATION)
  4. normalizedTarget = normalize(invocation.target)   # TCB 内规范化
     assert matchResource(normalizedTarget, ref.purpose.resourcePattern)
       else Reject(SIGN_POLICY_VIOLATION)
  5. assert checkConditions(invocation, ref.purpose.conditions)
       else Reject(SIGN_POLICY_VIOLATION)
  6. wireRequest = constructWire(normalizedTarget, invocation.body, invocation.headers)
     # 代签器构造 wire format——handler 永不接触原始字节
  7. signedRequest = sign(wireRequest, ref.credential)
  8. audit: sign-policy-passed{refId, service, action, resource, maxUses}
  9. return SignedRequest
```

**P21 的核心**：规范化（normalize / constructWire）在 **TCB 内**完成，禁止将规范化责任下推给 handler 或对端。「校验器与被授权方语义一致性」由**唯一构造者**保证。

**签名策略（`purpose`）结构化**：

```typescript
export interface SigningPolicy {
  service: string;                    // 's3' | 'ec2' | 'sts' | ...
  actions: string[];                  // ['GetObject', 'ListBucket']
  resourcePattern: string;            // 'arn:aws:s3:::my-bucket/*'
  conditions?: {
    maxBodyBytes?: number;
    allowedHeaders?: string[];
    maxTTL?: Duration;
    sourceIpCidr?: string;
    maxUses?: number;                 // SignedRequest 是策略内可重放凭证
    maxUsesWindow?: Duration;
  };
}
export interface SecretRef {
  refId: string;
  label: SensitivityLabel;
  allowedSinks: string[];             // 工具集
  purpose: SigningPolicy;             // 结构化
  parseLevel: 'L1' | 'L2' | 'L3';
}
```

**`maxUses` 语义**：SignedRequest 本身在策略内可重放（如 SigV4 的签名在 TTL 内可重复使用）。`maxUses` + `maxUsesWindow` 限制重放窗口；代签器维护使用计数，超限即拒 `SIGN_MAX_USES_EXCEEDED`。

**「代签」的安全价值全部押在 3–5 步的策略校验 + 第 6 步的唯一构造者语义上**。

#### 6.3.3 TCB 面积诚实声明

原文**必然进入代签器（TCB 内）进程内存**——签名必须在某处用原文计算。诚实声明：

> **原文进入代签器（TCB 内），永不进入 handler / 模型面 / 审计。**

代签器**永不记录原文**；密钥材料由根信任锚托管；代签器入 TCB，其密钥加载走根信任验签。

**响应回流**：⑨ 执行后，handler 收到签名请求的响应。响应内容被视为**工具输出**，其 `outputSensitivity` 声明决定打标与断流处置；若响应可能含敏感信息，走 R3-hard/flow 或 R4/阶梯治理。链路存在但属工具声明责任——本系统不承诺响应内容安全，只承诺打标与断流机制。

#### 6.3.4 绑定与解析边界

- **绑定**：断流时创建 `SecretRef`；`allowedSinks` 与 `purpose` 是**注册/派生时确定的**，不由模型在调用时指定，不随请求出现；
- **解析点唯一**：仅发生于 ⑨ 执行前代签器 / 令牌签发器 / Deployer 注入点，且仅当 `tool ∈ ref.allowedSinks`；
- **网关对 args 内句柄一律视为不透明字符串**：任何 InvocationRequest 字段都不能触发解析；
- **generic egress（`net.send` 任意 body）**：收到句柄字符串 → 拒绝 `HANDLE_UNRESOLVABLE` 或按配置原样透传（视为数据，不解析）+ 一等审计事件；
- **审计**：`handle-ref` / `handle-inject-origin` / `handle-refused` / `sign-policy-passed` / `sign-policy-violation` / `sign-max-uses-exceeded` 事件全量记录。

### 6.4 SecretRef 代签器实现要点

```
secretRefResolver(ref, tool, invocation) -> SignedRequest | Token | Injection | Reject:
  1. assert tool ∈ ref.allowedSinks else Reject(HANDLE_REFUSED)
  2. level = pickMax(ref.parseLevel, tool.maxParseLevel)   # L1 > L2 > L3
  3. switch level:
       L1: assert policyCheck(ref.purpose, invocation) else Reject(SIGN_POLICY_VIOLATION)
           assert checkMaxUses(ref, invocation) else Reject(SIGN_MAX_USES_EXCEEDED)
           return gatewaySign(ref, invocation)
             # 代签器构造 wire format——handler 永不接触
       L2: return issueCapabilityToken(ref, tool, ttl≤60s)  # 窄范围、可撤销
       L3: assert rootSigned(ref, 'L3-exception')
           return injectToProcess(ref, invocation)          # 受限兼容
  4. audit: handle-ref / handle-inject-origin / sign-policy-*
```

**TCB 属性**：代签器与令牌签发器入 TCB；密钥材料由根信任锚托管；代签器**永不记录原文**；令牌签发器维护**撤销表**；代签器维护 **maxUses 计数器**。

### 6.5 账本版本与线性化

数据流账是**多写者（并行 Steps）单读者（裁决器）**结构。若无线性化，出站检查可能读到陈旧账本放行，而并发读敏感的写入尚未提交。

**定义**：

- 账本状态为 `(ledgerVersion, entries)`，`ledgerVersion` 单调递增；
- 每次写入（⑩ 打标/断流）在**提交点**原子执行：`entries' = entries ∪ {e}; ledgerVersion' = ledgerVersion + 1`；
- 提交点即线性化点——所有写入在提交点全序。

**happens-before 规则**：

1. **同 Step 内**：Step 的读 → Step 的写，程序序 hb；
2. **同并行组内**：任一 Step 的账本写提交 → 组内后续 Step 的账本读，hb（网关在组内引入**屏障**）；
3. **跨组**：前一组的所有写入提交 → 后一组任一读取，hb；
4. **审批恢复**：审批挂起期间的写入在恢复时重读账本（保守重裁决）；
5. **世代切换**：切换前的账本状态（或继承事件集）→ 切换后新世代的第一笔读取，hb；
6. **世代级确认失效（A2a）**：确认签署时的 `ledgerVersion` → 后续裁决读同步计算前缀；**不依赖异步监听**。

**屏障实现**：

- 网关在并行组进入裁决阶段时，对账本写入引入**屏障**：等待组内已发起写入全部提交后，才允许裁决读；
- 屏障不阻塞新写入提交，只保证裁决读到的是**全序前缀**；
- 若屏障超时（写入长期未提交）→ fail-closed 拒绝（`LEDGER_BARRIER_TIMEOUT`）。

**保守方向**：任何读取若观察到版本推进，必须**重读最新版本再裁决**；禁止用陈旧版本放行。缺事件按条件破缺（N5）叠加此规则。

### 6.6 引用型 sink 的 TOCTOU 防护

屏障覆盖**裁决时刻**（⑤ 读账本的全序前缀），不覆盖**执行时刻**（⑨）。对**引用型 sink**（content-by-reference），存在 ⑤ 裁决通过到 ⑨ 执行之间的直通窗口。

**规格要求**：

> **条件 sink 若为引用型，须在 ⑤ 时内容投影 inline 或哈希钉版。**
>
> - **inline 投影**：⑤ 时读取引用内容并入 payload，⑨ 使用该 inline payload（天然免疫 TOCTOU）；
> - **哈希钉版**：⑤ 时记录引用内容的哈希；⑨ 执行前重读引用内容并校验哈希，不一致则拒 `REFERENCE_DRIFT`。

**路径解析一致性（P21 延伸）**：⑤ 网关读引用路径须**先 realpath 规范化，再对照标注**——否则 symlink 重定向可绕过投影与哈希。规范化在 TCB 内完成。

**适用范围**：仅**带 R3-flow 条件**的引用型 sink。无条件 sink 不引入此约束。

**inline 优先**：默认 inline 投影；哈希钉版适用于 payload 过大的场景。

### 6.7 边界与残余风险

- **沙盒代劳不了数据流控制**：模型上下文是 read 工具的合法输出地——原文一旦入枢纽，任何后续出站 args 都是出口；控制必须在源头与管道解决；
- **账本域**：默认上下文世代 + 工作区 derived label（§6.8）。**显式持久化到系统外部的敏感数据**不在覆盖内——**最终边界始终是源头断流**；
- **探测是概率性的**：内容探测有漏报，不承担安全承诺——承诺由 R3-hard 断流承担；
- **R3-flow 的代价**：条件裁决依赖账本完备性；账本缺事件时条件谓词按**破缺**处理（fail-safe）；
- **L3 原文注入的残余**：handler 进程可能写日志、fork、崩溃转储——故 L3 是受限兼容路径，需根层签署 + 短 TTL + 审计一等事件；
- **L1 代签的残余**：策略校验覆盖 service × action × resource × 条件；若策略本身写得过宽（如 `s3:*` + `*`），代签仍可被滥用——**策略宽度是根层责任，不在本系统承诺内**；
- **响应回流**：⑨ 后 handler 收到的响应属工具输出，其安全性由工具 `outputSensitivity` 声明 + R3/R4 治理；本系统不承诺响应内容安全（§6.3.3）；
- **多委托人共享上下文**：未覆盖，需独立治理面；
- **overlay 的保守近似性**：derived label 是会话级布尔的保守近似（「曾读过敏感 → 该文件可能含敏感」），非精确污点；**上限 sensitive、只收紧 flow 层**（P24），不驱动 hard 层。

### 6.8 Derived Label Overlay（v1.3 三轴修正）

**问题**：持久化维度的数据残留——世代公理修复了「账本重置」维度，继承修复了「压缩清洗」维度，但 workspace artifact 中继未做缓解：

```
世代 1：读 sensitive（记账）→ fs.write.workspace 把内容写入 report.txt
        → 世代结束，账本归档。
世代 2：读 report.txt——无标注，N1 缺省 internal → 无账本事件
        → net.send 引用或携带其内容 → 条件裁决成立 → 静默放行。
```

**修复**：

> ⑩ 执行**写操作**时，若当前账本（含本次调用自身的读事件）含**未断流** ≥sensitive 读，对目标路径施加 **derived label = sensitive**（overlay 标注）。

#### 6.8.1 三轴修正（A1）

**触发轴（A1a）**：

| 项                         | 内容                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **只对未断流读施加** | 断流读（R3-hard）的原文从未进入上下文，后续写不可能包含该内容——**断流读不产生 overlay**。overlay 是纯误报，且推翻守恒律对断流的兑现。 |
| **施加求值点 = ⑩**  | 在数据流账提交时求值；**包含本次调用自身的读事件**——否则 `fs.copy` 从 overlay 文件到干净文件的目标不会被施加（移动逃逸）。          |
| 判定输入                   | 当前账本（指定版本）中`transferDir=ingest ∧ label ≥ sensitive ∧ 未断流` 的事件集合                                                       |

**层级轴（A1b）**：

| 项                                | 内容                                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **overlay 上限 sensitive**  | derived label 不取值 secret；即使原读事件为 secret（未断流场景不存在，但防御性上限）。                                                                                                                                      |
| **只收紧 flow 层**          | overlay 参与条件破缺判定、审批触发、出站检查；**不驱动 V17 写 forbidden、不驱动 R3-hard 读断流**。                                                                                                                    |
| **hard 层只由静态标注触发** | 优先序显式分层（§4.5）；overlay 与 hard 层之间不参与。                                                                                                                                                                     |
| 理由                              | derived label 是会话级布尔的保守近似，不该接入设计上「精确无例外」的 hard 层。走查：读敏感数据 → 写 report.txt → overlay=secret → 更新报告 forbidden、读报告句柄化、delete 走 R1 gated——正常工作流被拖进 hard 层僵局。 |

**生存期轴（A1c）**：

| 域                                 | 生存期                                   | 理由                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **workspace**                | **manual-clear（默认）**           | workspace 文件活得比 Session 久；session 结束自动清除会导致跨 Session 中继重开（Session 1 写 report.txt → overlay 清除 → Session 2 读到 internal → egress 静默） |
| sandbox / draft                    | 随域销毁（`sandbox-teardown`）         | 域销毁本就删文件；overlay 生命周期与文件一致                                                                                                                        |
| **清除与 flush 解耦（P26）** | **overlay 清除是独立一等安全决策** | 「重置数据流账」不批量清 overlay；UI 逐文件确认；用户显式决定「此文件不再受 overlay 保护」                                                                          |

**overlay 清除**：

- **Session 结束**：workspace 域 overlay **不自动清除**；sandbox/draft 随域销毁；
- **人工清除**：审批人逐文件确认清除（审计 `derived-label-cleared{attestor, target, reason}`）；
- **flush 交互**：用户显式 flush 时，UI 提供**两个独立选项**——「重置数据流账」（清上下文账本）与「清除 derived label overlay」（逐文件确认）；**两者解耦，不批量静默**。

#### 6.8.2 语义表

| 项                 | 内容                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 触发               | ⑩ 写操作 + 当前账本（含本次读事件）含**未断流** ≥sensitive 读                                                                            |
| 施加对象           | 目标路径（绝对路径，realpath 规范化）                                                                                                            |
| Label              | `sensitive`（**上限**）                                                                                                                  |
| 生存期             | workspace:`manual-clear`；sandbox/draft: `sandbox-teardown`                                                                                  |
| 存储               | Derived Label Overlay 管理器（TCB 内）；与 AssetLabel 注册表分离——overlay 是运行时状态                                                         |
| 与 AssetLabel 关系 | 值层检查时，overlay**参与 N15 裁决**（取最严 + 更具体优先）；overlay 的 specificity = `∞`（派生优先于静态）；**但只收紧 flow 层** |
| 审计               | `derived-label-applied{target, label, derivedFrom[], ledgerVersion}` 一等事件                                                                  |
| 清除               | workspace: 人工逐文件确认；sandbox/draft: 随域销毁                                                                                               |

#### 6.8.3 跨世代追踪走查

| 场景                                         | 判定路径                                                | 结果                              |
| -------------------------------------------- | ------------------------------------------------------- | --------------------------------- |
| 世代1 读 sensitive（未断流）→ 写 report.txt | ⑩ 施加 overlay=sensitive；`derivedFrom` 记读事件 id  | `derived-label-applied`         |
| 世代1 读 secret（断流）→ 写 report.txt      | **断流读不产生 overlay**                          | 无 overlay（原文从未进入上下文）  |
| 世代2 读 report.txt                          | overlay 参与 N15 裁决（specificity=∞）；命中 sensitive | 账本记 sensitive 读；条件破缺     |
| 世代2 出站携带 report.txt 内容               | 条件破缺                                                | 审批（摘要含 derived label 来源） |
| Session 结束（workspace）                    | overlay**不自动清除**                             | 跨 Session 追踪继续               |
| 用户 flush「重置数据流账」                   | **overlay 不清除**（解耦）                        | 上下文账本清；overlay 保留        |
| 用户逐文件确认清除 overlay                   | `derived-label-cleared`                               | 该文件不再受 overlay 保护         |
| `fs.copy` overlay 文件 → 干净文件         | ⑩ 含本次调用自身的读事件                               | 目标也施加 overlay（堵移动逃逸）  |

**flush 语义诚实化**：UI 必须同时呈现两个独立选项——「重置数据流账」（清上下文账本）与「清除 derived label overlay」（逐文件确认）。提示：**「重置数据流账不会清除工作区文件的保护；如需清除，请逐文件确认」**。

---

## 7. 高危值层治理

### 7.1 动词匹配器 → R1

命令/语句模式（`rm`、`DROP/TRUNCATE`、`shred`、`dd of=/dev/*`、`git push --force`、`DELETE` 无 WHERE`）在值层识别实际操作的真实角色，语义重派：

- `rm` → delete（committed → R1）
- `DROP` → ddl（committed → R1）
- SQL 可静态判则静态判，不可判保守处理。

匹配器入 TCB。

### 7.2 资产标注 → Label 层

白名单不豁免原则：paths 白名单显式包含标注资产时，R3/R5/hard 层下限依然生效。模式冲突裁决见 §4.2（含负例条目与压制聚合呈现）。

### 7.3 边界集（R5 清单）

| 类别           | 资产示例                                                                                                                                                     | 语义                                                      | 写处置                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 身份持久化     | `~/.ssh/authorized_keys`、云 IAM 凭据/策略附件、API token 轮换面                                                                                           | 一次未签署的 AgentGrant                                   | 多数 Label=secret →**V17 hard 优先，forbidden**；非 secret 者由 R5 → gated |
| 执行持久化     | crontab、systemd units/Timer、shell rc、启动项、`~/.config/autostart/**`                                                                                   | 未来的自主执行权                                          | R5 → gated + boundary-write                                                       |
| 供应链钩子     | git hooks、husky/pre-commit、CI 配置、包管理器 rc                                                                                                            | 借未来动作放大                                            | R5 → gated + boundary-write                                                       |
| 工具配置持久化 | `~/.gitconfig`（alias / core.editor / hooksPath）、`~/.npmrc`、`~/.pip/pip.conf`、`~/.docker/config.json`、shell profile（`.bashrc` / `.zshrc`） | 借未来动作放大（alias 注入 / 编辑器劫持 / registry 劫持） | R5 → gated + boundary-write                                                       |
| 自身包络       | 本 harness 的 grant store、policy 文件、工具注册表、**标注注册表与规则配置（TCB 自指）**、配置                                                         | 直接改写权限格                                            | R5 → gated + boundary-write                                                       |

**T3 回归语料**：边界集应挂入 MITRE ATT&CK 持久化目录作为回归语料——覆盖 T1546、T1547、T1543、T1574、T1195 等对应技术。

**负例条目策展（B1）**：边界集相关 pattern 也应审查过宽性——如 `~/.config/**` 全标 boundary 可能包含无害配置；负例条目走 T3 全量回归。

---

## 8. 网络与资金

### 8.1 网络

- **egress proxy 是唯一出口**：命名空间无直连；域名校验在连接时（解析 → pin IP → 建连 → 二次解析不一致即拒）；
- `net.fetch` = `ingest`：返回内容统一打 **untrusted 标**，作为数据进入枢纽、不作为指令——爆炸半径压缩，内容层免疫不在承诺内；
- `net.send` = `egress`：R2 下限 gated；出站检查与 R3-flow 条件裁决必经；句柄解析白名单约束（§6.3）；
- **`chat` 输出**：在多委托人场景下视为 egress sink；默认单委托人假设，多委托人共享上下文属未覆盖风险域。

### 8.2 资金

pay = committed + egress 双轴叠加：

| 规则       | 内容                                                         | 来源          |
| ---------- | ------------------------------------------------------------ | ------------- |
| 下限 gated | 任何层级不可 auto，白名单不豁免                              | R1 ∧ R2      |
| 金额预授权 | `amountLimit` 唯一预授权形态：≤ 限额静默 + 日志；超限必问 | R2 结构化范围 |
| 审批回显   | 必带交易摘要，人确认具体交易而非类别                         | V18           |
| 重复防护   | 同一收款方短窗口重复扣款 → 强制再次确认                     | —            |
| 订阅类     | 自动续费默认 forbidden，需根契约显式条款级授权               | R1            |

---

## 9. 执行强制与可信基

### 9.1 后端选型（fail-closed）

| 平台    | 后端链                                 |
| ------- | -------------------------------------- |
| Linux   | bwrap → Landlock + seccomp 原生启动器 |
| macOS   | Seatbelt                               |
| Windows | 受限写 token（能力受限，见 §9.2）     |

请求受限模式但无可用后端 → `SANDBOX_UNAVAILABLE`，拒绝在无沙盒下运行。审批服务缺位同样 fail-closed。

### 9.2 能力矩阵封顶

后端无法强制执行的轴（如 Windows 的读/网络），**V15 封顶二选一**：

| 选项                        | 语义                                                                                                                                   | 适用                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **forbidden（默认）** | 没有内核强制就没有执行——与`SANDBOX_UNAVAILABLE` 同款 fail-closed 逻辑                                                              | 默认；安全优先             |
| **gated + 强制披露**  | 允许执行，但审批回显必须**显式披露强制缺口**：「此轴无内核强制，批准范围 ≠ 实际可达范围；handler 进程内可绕过 args 声明的路径」 | 部署档显式选择；可用性优先 |

**为什么 gated 单独不够**：gated 的语义是「人批准后执行」，但人批准的是 `paths=[~/docs]`，而受限写 token 不限制读——审批人以为批准了范围，实际批准的是全盘读。故 gated 必须叠加**强制披露**。

**可逆凭据不被支持 → R6 不生效回落 gated**。

**`fs.read.host + run_code` 在 Windows 上的组合**：默认 forbidden；若部署档选择 gated，审批回显必须包含上述披露文案。

### 9.3 环境绑定三规则

1. **handler 无特权**：执行环境由 Deployer 按 Domain + Role + 凭据统一配置，handler 内部永不做权限判断；
2. **代码执行同轨**：`run_code` 类载荷套用与外部调用相同的内核 profile——同权限格、同标注、同动词匹配器；
3. **外部进程显式标注**：无法 confine 的进程 = `external.*` → opaque → R4（或经信任阶梯收容消解）→ 下限 gated + 风险事件。

**沙盒边界加固注记**：`domain-teardown` 凭据以沙盒边界真实为条件——profile 必须含 symlink 逃逸加固（路径 realpath 规范化后二次校验）；边界失效 → R6 档位自动失效回落 gated。

**kill switch × task-scratch 清理**：`domain-teardown` 由沙盒销毁保证；`task-scratch`（workspace 内 draft 暂存区）的清理由**独立的 Turn 结束清理钩子**保证，该钩子**必须被 kill switch 触发**。若清理钩子失败，审计 `task-scratch-cleanup-failed` 一等事件，并在下次任务启动时对该 draft 命名空间执行强制清理。

### 9.4 可信计算基（TCB）

P6 的精确含义：内核强制保证**无旁路**；内核执行的是策略——**策略错了，强制也错**。故策略供给链整体入 TCB。

**TCB 清单**：

- AssetLabel 注册表（含负例条目）
- Role 声明与凭据
- R1–R6 求值器
- 全对守卫
- 规则优先序实现（含 P24 显式分层）
- Deployer profile 生成
- SecretRef 解析器与代签器（含签名策略校验器 + wire format 构造器）
- egress proxy
- 数据流账
- 动词匹配器
- 条件预授权裁决器
- 账本版本管理器
- Derived Label Overlay 管理器
- 根信任锚客户端

| #  | 治理要求                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 | **版本与签名**             | 注册表与规则配置带内容哈希 + 版本；derive 快照钉住所用版本（`pinned: {labels@v, roles@v, rules@v, rootTrust@v}`）——策略错误可精确归因到版本，运行中任务不受后续变更影响                                                                                                                                                                                                                                                                      |
| T2 | **注册表自指边界化**       | 标注注册表、规则配置、工具注册表的写入 = 边界资产写（R5）——改规则的人走与改权限格同级的门                                                                                                                                                                                                                                                                                                                                                      |
| T3 | **回归语料（v1.3 更新）**  | 全规则 × 全标注 × 全档位金测矩阵 + 优先序断言 + 对抗用例（标注漂移、角色谎报、域混淆、句柄旁路尝试、条件预授权绕过尝试、账本缺事件 fail-safe、代签降级攻击、签名策略绕过、令牌重放、canonical form 攻击、wire format 构造者绕过尝试、derived label 漂移、**overlay 移动逃逸（fs.copy）**、**世代级确认失效竞态**）+ MITRE ATT&CK 持久化目录回归语料 + **负例条目策展全量回归（B1）**；注册表任何变更全量回归后才可发布新版本 |
| T4 | **红队**                   | 定期对 TCB 组件做对抗评审：标注遗漏（N1 兜底验证）、凭据谎报（外部工具恒 opaque 兜底验证）、解析旁路（N4 验证）、条件谓词时序（账本原子性）、代签器密钥路径、签名策略宽度、撤销表时效性、规范化语义一致性、**overlay 触发轴误报**、**overlay 层级越权**                                                                                                                                                                              |
| T5 | **平台签名 vs 用户追加**   | 内置标注/角色平台背书签名；用户追加走 N1 fail-safe 缺省 + R4 保守缺省，且追加行为本身记审计；**secret 级降级压制情形显式审计 + 聚合呈现（B3）**                                                                                                                                                                                                                                                                                            |
| T6 | **变更纪律**               | 标注/规则/凭据变更 = 根层事件，产生新版本并全量回归；禁止热改运行中任务的钉版快照                                                                                                                                                                                                                                                                                                                                                                |
| T7 | **授权通胀配套治理**       | 根层签署的成本上升会激励用户预授宽权限。配套：① PRESETS 覆盖 90% 常见任务；② 修订流快速通道 UX（但须过边界集求交，见 §12）；③**授权面宽度作为遥测指标**（初始 grant 的能力数分布、paths 集合大小、maxLabel 分布），异常宽度触发根层审阅提示；④ **overlay 施加率作为可选遥测**（并入 T7/T8 叙事，不构成独立机制）                                                                                                                |
| T8 | **审批呈现完整性责任声明** | 系统责任 = 结构化审批摘要的**生成与签名**（V18）；系统**不承诺**审批人正确理解摘要。摘要必须含：数据流来源、交易对手、金额、目标资产、**强制缺口披露（V15 gated 档）**、**derived label 派生的数据残留来源**、**世代级知情豁免文案（A2b）**。**审批率 SLO 改为基线偏移**：相对任务类型/用户历史基线的偏移量；绝对阈值在 R1/R2 恒 gated 系统里无意义                                                          |

### 9.5 根信任治理

TCB 不能自证——**根层签署、审批人身份、审计完整性、策略撤销必须由独立锚支撑**。

#### 9.5.1 根层签名

| 项       | 方案                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| 签名算法 | Ed25519（默认）；算法与密钥 ID 随快照钉版                                                                           |
| 私钥托管 | HSM / OS 钥匙串 / 外部 KMS；私钥永不进入 Agent 运行时进程                                                           |
| 签署内容 | 根`AgentGrant`、ContractRevision（含 **secret 级降级**）、信任阶梯升级、L3 例外、收容配置、根信任锚更新自身 |
| 验签点   | GrantStore 读入时、ContractRevision 应用时、阶梯状态机转移时、代签器密钥加载时                                      |
| 密钥轮换 | 新旧公钥并存窗口；快照钉`rootTrust@v` 保证旧任务用旧公钥验签                                                      |

#### 9.5.2 审批人认证与呈现

| 项                       | 方案                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份源                   | 外部 IdP（OIDC / SAML）或硬件密钥（WebAuthn / FIDO2）；**不接受 Agent 自报身份**                                                                                                                                    |
| 审批凭证                 | 短期审批令牌（≤5min），绑定具体`invocationId` + 交易/数据流摘要哈希                                                                                                                                                    |
| 审批回显                 | 必须展示 V18 要求的摘要；摘要哈希随审批令牌签名——**审批不可被替换为泛化同意**                                                                                                                                     |
| 双人规则                 | 高危操作（超过 amountLimit 的 pay、边界集写、L3 例外签署、**secret 级降级**）默认双人；单人需根层显式降级                                                                                                           |
| 呈现完整性               | 系统责任 = 摘要的生成与签名；系统不承诺审批人正确理解。摘要必须含：数据流来源、交易对手、金额、目标资产、**强制缺口披露（V15 gated 档）**、**derived label 派生的数据残留来源**、**世代级知情豁免文案** |
| 审批率 SLO               | 基线偏移告警（相对任务类型/用户历史基线）；阈值由根层配置                                                                                                                                                                 |
| **世代级知情豁免** | 审批人可签署；文案含敏感读次数、来源列表、derived-label 文件数；**同步失效判定**（A2a）                                                                                                                             |

#### 9.5.3 审计防篡改

| 项                 | 方案                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结构               | **只追加**（append-only）签名链：每条 DecisionLog 记录含前一条哈希 + 本条签名                                                                   |
| 签名者             | **网关持根派生的本地签名子密钥**（避免 HSM 吞吐瓶颈）；子密钥定期（默认每 5 分钟）checkpoint 到根信任锚；HSM 只用于子密钥轮换与 checkpoint 签名 |
| **已知残余** | 攻破网关（TCB 内攻击者）可伪造最近 checkpoint 周期内的任意链记录。窗口 = 5min checkpoint + 1h 锚定。这是标准离线日志问题；声明即可，不修复            |
| 外部锚             | 定期（默认每小时）将链头哈希**锚定到外部不可变存储**（对象存储 WORM / 透明日志 / 区块链，按部署）                                               |
| 验证               | 审计回放可验证：链完整、签名有效、锚点匹配；任一失败 →`AUDIT_TAMPER_SUSPECTED` 一等事件                                                            |
| 保留               | 审计记录保留期由根层配置；归档不删除；世代结束归档入长期存储                                                                                          |

#### 9.5.4 策略撤销与钉版失效

| 场景                 | 流程                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常撤销             | 根层签署`ContractRevision` → 新版本 → 运行中任务**不受影响**（钉版快照），新任务用新版本                                                                                            |
| 紧急撤销（策略错误） | 根层签署**撤销通告**（含目标版本哈希 + 理由）→ 撤销注册表更新 → 网关在下一个调用点对钉版旧快照执行 **fail-closed 拒绝**（`POLICY_REVOKED`），运行中任务立即停止该策略下的调用 |
| TCB 组件撤销         | 与上同，作用于代签器 / 裁决器 / 账本管理器 / overlay 管理器等；撤销后降级到安全基线（更保守）                                                                                                 |
| 撤销注册表本身       | 由根信任锚签名并锚定外部；撤销注册表的写入 = 最高级根层事件（双人 + HSM）                                                                                                                     |

#### 9.5.5 根信任锚的自举

根信任锚在首次部署时由**离线根密钥**建立（HSM + 纸质备份 / 分片保管）；其更新需**双人 + 离线根签名**；其客户端入 TCB，但**锚本身不在 TCB 内**——这是刻意的：TCB 不能自证，锚必须在其外。

---

## 10. 并发与线性化

### 10.1 公理（冲突可串行化）

两步骤冲突 ⟺ 二者触碰同一资源且至少一个为写。非冲突步骤可任意交错——与副作用多少无关。

### 10.2 推论一（范畴区分）

副作用是步骤的**标量属性**，冲突是步骤间的**关系属性**；「有副作用 → 串行」是范畴误判。

反例：`write a.doc` 与 `create dir` 资源不相交则并行安全；`a.doc` 写入被创建目录则路径前缀构成隐式依赖，必须串行。

### 10.3 推论二（正交双轴）

副作用约束的是重试安全（幂等键）与中止语义（补偿），与并行性正交——并行组内逐步独立重试、独立补偿。

### 10.4 隐式依赖显式化

因果边由计划器声明；资源冲突由结构化声明（reads/writes 的 ResourceRef，含路径前缀包含关系）静态推导；**声明缺失按保守方向处理——视为冲突、串行**。

**工程同构**：与构建系统 action graph（Make/Bazel）同一模型。

**与权限系统的分工**：并行不削检查（P11）——组内每次调用独立过完整管线、预算原子扣减、无组级豁免；调度器管补偿编排，ToolGateway 管检查与可中断。权限侧义务：派生在并发派单前完成且快照不可变——并行组共享同一 effective 快照（含 R3-flow 条件），组内账本事件对条件裁决可见且原子。

### 10.5 账本线性化摘要

完整定义见 §6.5。要点：

- 账本写入在**提交点**原子递增版本，提交点即线性化点；
- 组内裁决读前引入**屏障**，等待已发起写入提交；
- 读取指定 `ledgerVersion`，网关保证读到全序前缀；
- 观察到版本推进必须重读，禁止陈旧版本放行；
- 屏障超时 fail-closed；
- 引用型 sink 的 TOCTOU 残余由 §6.6 规格补齐；
- **世代级确认失效同步计算**（A2a）——不依赖异步监听。

---

## 11. 归因、审计与中止

**归因链**：`sessionId / turnId / stepId` 三层，映射 **session ≡ goal、turn ≡ task**。预算扣减挂 turnId：Turn 预算即 task 预算。归因上下文由 harness 侧通道注入，模型可见面零归因知识。

**decisionLog 事件**：

```
ruleHit(R1..R6) · rule-precedence · guard-pair · condition-attach · condition-verdict
boundary-write · handle-ref · handle-inject-origin · handle-refused
sign-policy-passed · sign-policy-violation · sign-max-uses-exceeded
token-issued · token-revoked · egress-check · danger-verb · clamp
derive-reject · grant-revision · escalation-* · full-trust-invocation
sandbox-unavailable · ledger-write · ledger-barrier · generation-switch
generation-egress-attestation · reference-drift · derived-label-applied
derived-label-cleared · label-resolution · policy-revoked
audit-tamper-suspected · task-scratch-cleanup-failed · approval-rate-alert
```

**归因完备（V10）**：`契约 spec(v) + derivedFrom + ruleHits + conditions + pinned TCB 版本 + pinned rootTrust 版本 + decisionLog（签名链）` 可回答「这个效果/这次钳制/这次条件裁决是在哪一层的哪条规则、哪个 TCB 版本、哪个根信任版本、哪次决定下发生的」。

**审计链**：DecisionLog 为只追加签名链（§9.5.3）；链头定期锚定外部；回放验证链完整、签名有效、锚点匹配。

**Kill switch 在权限格之外**：独立控制通道（进程信号 + 沙盒销毁两级），不经 policy 管线，任何 policy 不可阻挡；进程信号级 kill 必须触发 task-scratch 清理钩子（§9.3）。

---

## 12. 升权协议

| 规则                   | 内容                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一入口               | 升权是执行面通用协议（偏序短路），不挂任何工具 schema                                                                                                                                                                                                                             |
| 已生效短路             | 非严格更宽的请求 → 普通调用直行（V12）                                                                                                                                                                                                                                           |
| justification          | 仅严格更宽时校验非空                                                                                                                                                                                                                                                              |
| 审批语义               | `allowed-once`：绝不回写 grant；权限持久变化只走 ContractRevision                                                                                                                                                                                                               |
| 重试纪律               | 每次被拒至多一次升权重试；effective 已触顶时提示为「绕开」                                                                                                                                                                                                                        |
| 触发方式               | on-failure（默认）/ on-request / predeclare                                                                                                                                                                                                                                       |
| 修复回路纪律           | 分级修复中 V12 保证同档重试不进审批；审批等待期受 settle 复查兜底                                                                                                                                                                                                                 |
| 信任阶梯隔离           | 模型升权请求与工具信任阶梯**无通路**——阶梯只由根层签署与审计窗口驱动                                                                                                                                                                                                      |
| 审批凭证               | 审批须绑定`invocationId` + 摘要哈希；审批令牌短期、可验签（§9.5.2）                                                                                                                                                                                                            |
| **修订快速通道** | 低风险 ContractRevision 可走单人快速签署。**判定条件（必须全部满足）**：① tier 不变；② maxLabel 不变；③ 新增 paths / hosts **与边界集求交为空**；④ 新增 paths **与 secret 标注求交为空**；⑤ amountLimit 不变。任一不满足即回落双人。快速通道规则属根层配置 |

**为什么「路径扩展但 tier 不变 = 低风险」不成立**：新增 path 可包含 boundary 资产（如扩到 `~/.gitconfig`）。快速通道判定须包含新增 paths × 边界集/secret 标注求交，命中即回落双人。

---

## 13. 不变量

| #                          | 不变量                                                                                                                                                            | 执行点                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| V1                         | 授权只在根层；R5（边界写 = 根层事件）是其推论                                                                                                                     | 根层断言 + 边界集                         |
| V2                         | 任务层无授予字段                                                                                                                                                  | GrantStore schema 校验                    |
| V3                         | effective 是计算值：tier = meet ⊔ R 下限；条件预授权为快照成分                                                                                                   | 派生求值器                                |
| V4                         | 派生单调收紧                                                                                                                                                      | meet + R 下限 + 单测基线                  |
| V5                         | closed-world                                                                                                                                                      | 供给检查                                  |
| V6                         | 唯一咽喉 + 环境按 Domain/Role/凭据绑定                                                                                                                            | ToolGateway 管线 + Deployer               |
| V7                         | 守卫派生时全局执行（全对）                                                                                                                                        | R3 全对求值                               |
| V8                         | R 系下限与 hard 层不参与 meet，任何层不可放宽；full-access 亦不豁免                                                                                               | 钳制次序 + 硬编码                         |
| V9                         | kill switch 在格之外                                                                                                                                              | 独立通道                                  |
| V10                        | 每次放行与每次钳制/条件裁决可归因（含 TCB 版本 + 根信任版本）                                                                                                     | 三联回放 + ruleHit + pinned               |
| V11                        | 调用身份由 harness 注入                                                                                                                                           | 管线构造时                                |
| V12                        | 非严格更宽的升权 = 普通调用直行                                                                                                                                   | 偏序短路                                  |
| V13                        | fail-closed                                                                                                                                                       | 沙盒/审批/代理/secrets/账本缺件即拒       |
| V14                        | 一次调用内 deny 单调不可翻                                                                                                                                        | pre-execute 钩子吸收态                    |
| V15                        | 不可强制执行的效果**默认 forbidden**；部署档可选 gated + 强制披露；不被支持的凭据使 R6 失效                                                                 | 能力矩阵封顶 + 审批披露                   |
| V17                        | secret 写 forbidden 无例外（hard 层，优先于 R5）；secret 读必断流                                                                                                 | 优先序 + R3-hard + 边界集                 |
| V18                        | pay 审批必带交易摘要；限额是唯一预授权形态                                                                                                                        | 审批 seam                                 |
| N1                         | 标注 fail-safe：未标注 = internal，存疑 = sensitive，保守方向不可关闭                                                                                             | 标注求值器                                |
| N2                         | 生成完备性限定于 Domain/Label/Role 语义域；域外风险由独立治理面承担                                                                                               | 类型结构 + 范围声明                       |
| N3                         | 并发声明缺失按冲突处理（串行）                                                                                                                                    | 冲突图构建                                |
| N4                         | SecretRef 仅在其绑定`allowedSinks` 内解析；网关对 args 内句柄一律不透明；generic egress 永不解析                                                                | 代签器/令牌签发器 + 拦截                  |
| N5                         | 条件预授权属 effective 快照成分，不回写 grant；账本缺事件按条件破缺处理                                                                                           | 快照结构 + 账本 fail-safe                 |
| N6                         | 信任阶梯只消解 R4 不确定性惩罚，永不触碰 R1/R2 下限；升级仅根层签署                                                                                               | 阶梯状态机 + ContractRevision             |
| N7                         | 账本域默认绑定上下文世代；账本条目在世代内持续有效                                                                                                                | 账本管理器 + 世代生命周期                 |
| N8                         | 账本读取必须指定版本且读到全序前缀；陈旧版本禁止放行；屏障超时 fail-closed                                                                                        | 账本版本管理器 + 屏障                     |
| N9                         | SecretRef 默认经 L1 代签 / L2 令牌解析，原文进入 handler 仅限 L3 受限兼容路径                                                                                     | 代签器 + 令牌签发器                       |
| N10                        | 根信任锚在 TCB 之外；审计只追加签名链 + 外部锚；撤销注册表由根签名；TCB 不能自证                                                                                  | 根信任锚客户端 + 审计链验证               |
| N11                        | 自动压缩触发的世代切换必须继承账本（默认完整事件集，最小部署档布尔摘要）；只有用户显式 flush 清账本；保守方向不可配置关闭                                         | 世代切换器 + P19                          |
| N12                        | L1 代签必须经结构化签名策略校验（service × action × resourcePattern × 条件）；校验失败即拒`SIGN_POLICY_VIOLATION`                                            | 代签器 + 签名策略校验器                   |
| N13                        | 引用型条件 sink 必须在 ⑤ 时内容投影 inline 或哈希钉版；⑨ 前哈希不一致即拒`REFERENCE_DRIFT`；路径 realpath 规范化                                              | 值层投影器 + 引用校验器 + 规范化器        |
| N14                        | kill switch 的进程信号级必须触发 task-scratch 清理钩子；清理失败记一等事件并在下次任务启动时强制清理                                                              | kill switch + 清理钩子                    |
| N15                        | 模式冲突裁决：secret 级平台强制不可降级（**负例条目为合法出口**）；sensitive 及以下用户显式声明优先；boundary 取并集；压制情形显式审计 + **聚合呈现** | 标注求值器 + 压制聚合器                   |
| N16                        | 代签器从结构化 invocation 构造 wire format；handler 永不接触 wire format；规范化责任在 TCB 内                                                                     | 代签器 wire 构造器 + P21                  |
| **N17（v1.3 修正）** | **overlay 只对未断流 ≥sensitive 读施加；施加求值点 = ⑩ 且含本次读事件；上限 sensitive；只收紧 flow 层，不驱动 hard 层**                                   | 写路径检查 + overlay 管理器 + P22/P24/P25 |
| **N18（v1.3 修正）** | **世代级知情豁免签署后本世代 egress 静默；有效性 ⟺ 当前账本版本前缀中无晚于签署 `ledgerVersion` 的 ≥sensitive 读事件；裁决时同步计算，不依赖异步监听**  | 确认管理器 + 账本版本前缀 + P23           |
| N19                        | 修订快速通道判定必须包含新增 paths × 边界集/secret 标注求交；命中即回落双人                                                                                      | 快速通道判定器                            |
| **N20（v1.3 新增）** | **overlay 清除与 flush 解耦：workspace 域默认 manual-clear；overlay 清除是独立一等安全决策，UI 逐文件确认；flush 不批量清 overlay**                         | overlay 管理器 + flush 交互 + P26         |

---

## 14. 示例走查

| 场景                                                                  | 判定路径                                                                                  | 结果                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm install`（effective 含 read:sensitive，本世代未读敏感）        | R3-flow 条件成立（账本净）                                                                | 静默放行——未使用不摩擦                                                     |
| 本世代已读 sensitive 后`net.send`                                   | R3-flow 条件破缺                                                                          | 转审批（带数据流摘要）/ 拒`EGRESS_SENSITIVE`                               |
| Turn1 读 sensitive，Turn2 出站（同世代）                              | 账本域 = 上下文世代                                                                       | **破缺 → 审批**                                                       |
| 模型大量输出 → 自动压缩 → 新世代出站                                | 自动压缩继承完整事件集；条件仍破缺                                                        | **破缺 → 审批**                                                       |
| **继承后审批人签署世代级知情豁免**                              | **文案含敏感读次数 + 来源列表 + derived-label 文件数；同步失效判定**                | **静默（记审计）**                                                     |
| **豁免签署后发生新敏感读**                                      | **同步计算：当前账本版本前缀含晚于签署版本的读事件**                                | **豁免失效；重新进入审批**                                             |
| 用户显式`flush`                                                     | 用户意图清账；UI 呈现「重置数据流账」+ 「清除 derived label overlay」（逐文件）二独立选项 | 审计`generation-switch{reason: user}`                                      |
| **世代1 读 sensitive（未断流）→ 写 report.txt**                | **⑩ 施加 overlay=sensitive；`derivedFrom` 记读事件 id**                          | **`derived-label-applied`**                                          |
| **世代1 读 secret（断流）→ 写 report.txt**                     | **断流读不产生 overlay**                                                            | **无 overlay（原文从未进入上下文）**                                   |
| **世代2 读 report.txt**                                         | **overlay 参与 N15 裁决（specificity=∞）；命中 sensitive**                         | **账本记 sensitive 读；条件破缺**                                      |
| **世代2 出站携带 report.txt 内容**                              | **条件破缺**                                                                        | **审批（摘要含 derived label 来源）**                                  |
| **Session 结束（workspace）**                                   | **overlay 不自动清除**                                                              | **跨 Session 追踪继续**                                                |
| **用户 flush「重置数据流账」**                                  | **overlay 不清除（解耦）**                                                          | **上下文账本清；overlay 保留**                                         |
| **`fs.copy` overlay 文件 → 干净文件**                        | **⑩ 含本次调用自身的读事件**                                                       | **目标也施加 overlay（堵移动逃逸）**                                   |
| **写 overlay=sensitive 的 report.txt**                          | **overlay 只收紧 flow 层，不驱动 V17**                                              | **按静态标注路径处理；不触发 forbidden**                               |
| `rm -rf src/`                                                       | 动词匹配 → delete（committed）→ R1                                                      | gated 恒                                                                     |
| `DROP TABLE users`                                                  | → ddl（committed）→ R1                                                                  | gated 恒，白名单不豁免                                                       |
| 写`~/.ssh/config`                                                   | secret → V17 hard                                                                        | forbidden                                                                    |
| 写`~/.ssh/authorized_keys`                                          | secret ∧ boundary：R5 与 V17 同时命中                                                    | forbidden——V17 hard 优先                                                   |
| 写 crontab                                                            | sensitive ∧ boundary：仅 R5                                                              | gated + boundary-write                                                       |
| 写`~/.gitconfig` alias                                              | boundary 工具配置持久化                                                                   | gated + boundary-write                                                       |
| 读`.env`（结构化工具）                                              | secret，source → R3-hard 断流                                                            | executed，返回 SecretRef；原文不进枢纽                                       |
| **读 `**/.env.example`（负例条目）**                          | **平台策展负例条目：known-safe template**                                           | **不命中 secret；按 internal 处理**                                    |
| **读 `**/*.pub.pem`（负例条目）**                             | **平台策展负例条目：公钥证书**                                                      | **不命中 secret**                                                      |
| **用户追加 `**/.env.example: internal`**                      | **负例条目已覆盖；用户声明与负例一致**                                              | **internal 生效**                                                      |
| **用户追加 `**/.env: internal`（无负例）**                    | **N15：secret 级平台强制不可降级**                                                  | **仍为 secret；压制审计 + 聚合呈现**                                   |
| AWS 句柄传入`aws.s3.list`（工具支持 L1）                            | handler 提交结构化 invocation；代签器策略校验通过；构造 wire format 并签名                | executed——handler 永不接触 wire format                                     |
| 被注入 handler 试图构造 canonical 形式匹配但服务端解码指向其他 bucket | handler 无法构造 wire format——它只提交结构化参数；代签器构造 + 校验一致                 | 无法绕过；越权请求被`SIGN_POLICY_VIOLATION` 拒绝                           |
| 同上，工具仅支持 L3                                                   | 根层已签署 L3 例外                                                                        | executed——原文注入 +`handle-inject-origin` 一等事件                      |
| 句柄字符串出现在`net.send` body                                     | 无 sanctioned 通道                                                                        | 拒`HANDLE_UNRESOLVABLE` 或原样透传 + `handle-refused`                    |
| 并行 Steps：A 读 sensitive，B`net.send`（同组）                     | 屏障：B 的裁决读等待 A 的账本写提交                                                       | 破缺 → 审批                                                                 |
| 账本屏障超时                                                          | fail-closed                                                                               | 拒`LEDGER_BARRIER_TIMEOUT`                                                 |
| 引用型条件 sink：⑤ 裁决净 → 并行读敏感写被引用文件 → ⑨ 执行       | inline 投影 / 哈希钉版 + realpath 规范化                                                  | inline 免疫；哈希不一致拒`REFERENCE_DRIFT`；symlink 重定向被 realpath 拦截 |
| `db.read` 用户表 + `net.send: auto`                               | R3-flow 全对自动附加条件                                                                  | 未读 → 静默；读了 → 审批                                                   |
| 支付 ¥50 / ¥5000                                                    | pay = committed+egress → R1∧R2                                                          | ≤限额静默+日志 / 超限审批带摘要                                             |
| 沙箱临时文件 / draft 暂存区写                                         | reversible + 凭据                                                                         | R6 → auto；Turn 结束销毁                                                    |
| kill switch 触发                                                      | 进程信号 + 沙盒销毁 + task-scratch 清理钩子                                               | sandbox 销毁 + draft 清理；失败记`task-scratch-cleanup-failed`             |
| MCP external 工具（T0 试用）                                          | opaque → R4 最坏角色                                                                     | gated + full-trust-invocation                                                |
| 同一工具升级至 T1                                                     | 沙盒 jail + proxy 白名单实测效果面                                                        | 下限降为「声明角色 ∧ 实测面」，read 类可 auto                               |
| 该工具`D_KL ≥ τ_kl`（窗口内）                                     | 降级判据                                                                                  | 即时回落 T0，全量事件恢复                                                    |
| 新工具早期窗口（callCount < 200）                                     | 集合比较替代 KL                                                                           | targetBucket / effectClass / verdictPath 集合无新增即稳定                    |
| 工具跨版本升级                                                        | 视为新工具                                                                                | 回落 T0                                                                      |
| Windows 上`fs.read.host + run_code`                                 | V15 默认 forbidden；部署档 gated 时审批披露强制缺口                                       | 默认 forbidden / gated + 披露                                                |
| 策略错误，根层紧急撤销                                                | 撤销通告 + 注册表                                                                         | 对钉版旧快照 fail-closed 拒`POLICY_REVOKED`                                |
| 审计链验证失败                                                        | §9.5.3                                                                                   | `AUDIT_TAMPER_SUSPECTED` 一等事件                                          |
| `run_code` 内 `import('fs')`                                      | 代码同轨                                                                                  | 同权限格、同标注、同动词匹配器                                               |
| 模型携带同档升权字段                                                  | V12 偏序短路                                                                              | 直行，无死循环                                                               |
| 并行 Steps（资源不相交）                                              | 冲突图 + 各自过管线 + 账本屏障                                                            | 双 executed，审计记并发组 DAG                                                |
| 用户热改标注注册表                                                    | 注册表 = 边界资产 → R5                                                                   | gated + boundary-write；运行中任务钉旧版本不受影响                           |
| 快速通道请求：新增 path`~/docs/*`                                   | 与边界集求交为空 + 与 secret 标注求交为空                                                 | 单人快速签署通过                                                             |
| 快速通道请求：新增 path`~/.gitconfig`                               | 与边界集求交非空                                                                          | 回落双人签署                                                                 |
| 审批率偏移超阈值                                                      | 基线偏移告警                                                                              | 触发根层审阅；telemetry 指标`approval-rate-alert`                          |

---

## 15. 形式化与保证等级

区分三级保证：**已证**（形式化验证）/ **已测**（属性测试 + 金测）/ **已审**（红队 + 对抗用例）。

### 15.1 形式化目标（已证）

| 不变量                            | 工具           | 规格要点                                                                                                                |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| V3（effective 是计算值）          | TLA+           | 状态机：derive 幂等；同输入同输出；无隐藏状态                                                                           |
| V4（派生单调收紧）                | Alloy          | 关系模型：子层 effective ≤ 父层（逐轴偏序）；反例搜索                                                                  |
| V7（全对守卫）                    | TLA+           | 对 effective 全对求值；无遗漏（枚举域有限）                                                                             |
| V8（下限不参与 meet）             | TLA+           | 钳制次序；meet 层无法放宽下限                                                                                           |
| V12（偏序短路）                   | Alloy          | 升权请求偏序：非严格更宽 → 无审批                                                                                      |
| V17（secret 写 forbidden）        | TLA+           | 纯有限状态不变量：∀ 写操作，label(target)=secret → verdict=forbidden；与 tier / 规则 / 配置无关                       |
| N4（句柄不透明）                  | TLA+           | 网关状态机：args 内句柄永不触发解析                                                                                     |
| N5（条件不回写）                  | TLA+           | 快照不可变；条件作为快照成分                                                                                            |
| N7（世代生命周期）                | TLA+           | 世代切换状态机：自动压缩 → 继承；用户 flush → 清；状态转移不可跳过                                                    |
| N8（账本线性化）                  | TLA+           | 提交点全序；屏障读全序前缀；陈旧版本禁止放行                                                                            |
| N11（自动压缩继承）               | TLA+           | 纯不变量：∀ 自动压缩，新世代账本 ⊇ 旧世代 ≥sensitive 事件集                                                          |
| N12（代签策略校验）               | TLA+           | 代签器状态机：无策略校验通过 → 无签名输出                                                                              |
| N16（wire format 构造者唯一）     | TLA+           | 代签器状态机：handler 提交 → 代签器构造 → 签名；无 handler-构造 wire format 路径                                      |
| **N17（overlay 分层边界）** | **TLA+** | **纯不变量：∀ 写操作，overlay 施加条件 = 未断流读 ∧ 求值点 ⑩；overlay.label ≤ sensitive；overlay 不驱动 V17** |
| **N18（确认失效同步）**     | **TLA+** | **状态机：确认签署 → 静默；裁决读同步计算 ledgerVersion 前缀；无异步窗口**                                       |
| **N20（清除解耦）**         | **TLA+** | **状态机：flush 不改变 overlay 集合；overlay 清除仅由显式逐文件确认触发**                                         |
| N19（快速通道判定）               | Alloy          | 关系模型：快速通道通过 → 新增 paths ∩ 边界集/secret = ∅                                                              |

**范围诚实**：形式化覆盖**可枚举状态**的子集；内容探测、标注漂移、行为签名统计不在形式化范围（属「已测/已审」）。

### 15.2 属性测试（已测）

| 属性                                | 测试方法                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 优先序矩阵                          | 全规则 × 全标注 × 全档位枚举；断言 hard > 下限 > meet；**overlay 不参与 hard 层**                                           |
| 派生确定性                          | 随机 grant + request；同输入同输出                                                                                                  |
| 账本世代域                          | 跨 Turn 场景；断言同世代读到；跨世代不读到                                                                                          |
| 世代切换语义                        | 自动压缩场景断言继承（完整事件集 / 布尔摘要）；用户 flush 断言清账；审计`generation-switch` 触发原因正确                          |
| **世代级确认同步失效（A2a）** | **签署后静默；新敏感读入账后立即失效（同步计算，无窗口）；确认 scope 正确**                                                   |
| 账本屏障                            | 并发写读；断言屏障后读全序前缀；超时 fail-closed                                                                                    |
| 引用型 TOCTOU                       | 裁决后并发写引用文件；断言 inline 免疫 / 哈希不一致拒`REFERENCE_DRIFT`                                                            |
| 路径 realpath 规范化                | symlink 重定向场景；断言规范化后对照标注；旁路必被拦截                                                                              |
| 代签/令牌                           | 降级攻击（L1 工具被诱导走 L3）；令牌重放；撤销时效                                                                                  |
| 签名策略校验                        | 被注入 handler 构造越权请求；断言`SIGN_POLICY_VIOLATION`                                                                          |
| canonical form 攻击                 | handler 提交恶意结构化参数试图诱导 wire format 语义差异；断言代签器唯一构造 + 规范化拦截                                            |
| maxUses 重放                        | SignedRequest 重放超限；断言`SIGN_MAX_USES_EXCEEDED`                                                                              |
| **overlay 触发轴（A1a）**     | **断流读不产生 overlay；未断流读产生 overlay；施加求值点 ⑩**                                                                 |
| **overlay 移动逃逸（A1a）**   | **`fs.copy` overlay 文件 → 干净文件；断言目标也被施加（⑩ 含本次读事件）**                                                 |
| **overlay 层级边界（A1b）**   | **overlay 上限 sensitive；overlay 不触发 V17 / R3-hard；只收紧 flow 层**                                                      |
| **overlay 生存期（A1c）**     | **workspace 域 manual-clear；sandbox/draft 随域销毁；session 结束不清 workspace overlay**                                     |
| **overlay 清除解耦（N20）**   | **flush 不清 overlay；overlay 清除仅由逐文件确认触发**                                                                        |
| 阶梯状态机                          | 全转移覆盖；`D_KL` 判据边界；小样本集合比较；跨版本升级回落                                                                       |
| 审计链                              | 篡改注入；锚点失配；签名失效                                                                                                        |
| 撤销注册表                          | 紧急撤销后钉版旧快照 fail-closed                                                                                                    |
| kill × task-scratch                | kill 触发清理钩子；钩子失败记事件；下次任务强制清理                                                                                 |
| 模式冲突裁决                        | 多重命中场景；断言 secret 不可降级 +**负例条目出口** + sensitive 以下用户优先 + boundary 并集；压制情形审计 reason + 聚合呈现 |
| 快速通道判定                        | 新增 path 命中边界集 / secret 标注 → 回落双人；空集 → 单人通过                                                                    |

### 15.3 红队（已审）

定期对 TCB 组件做对抗评审：标注遗漏、凭据谎报、解析旁路、条件谓词时序、代签器密钥路径、签名策略宽度、撤销表时效、审计锚完整性、根信任锚自举流程、世代清洗攻击路径、canonical form 与规范化语义一致性、**overlay 触发轴误报**、**overlay 层级越权**、**overlay 生存期逃逸**。

### 15.4 保证等级声明

本设计承诺：

- **P6 = 无旁路（enforcement gap = 0）**——形式化与实现可验证；
- **不承诺策略无误**——策略正确性由 TCB 治理 + 三级保证承担；
- **不承诺域外风险免疫**——见 §1.4 界定表；
- **不承诺签名策略宽度正确**——策略宽度是根层责任；
- **不承诺审批人判断质量**——系统责任 = 摘要生成与签名（§9.4 T8）；
- **不承诺审计在 checkpoint 窗口内的完整性**——网关被攻破可伪造最近窗口记录（§9.5.3）；
- **不承诺显式持久化到系统外部的数据安全**——最终边界是源头断流（§1.4）；
- **不承诺 overlay 精确性**——derived label 是会话级保守近似，上限 sensitive、只收紧 flow 层（P24）。

---

## 16. 实现计划

| 阶段         | 内容                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0** | 标注与规则引擎：AssetLabel 注册表（含**N15 区分 secret/以下 + 负例条目 + 压制聚合呈现**）；Role/凭据类型与信任策略；R1–R6 求值器 + 优先序矩阵（含 **P24 显式分层**）；CapabilityKey 映射；V15 封顶修正语义                                                                                                                                                                                            |
| **P1** | derive：CapabilityRule meet、全对守卫（R3-hard/R3-flow 双路）、ruleHit + conditions + TCB 钉版快照（含 rootTrust）、边界集、ContractRevision；V12 偏序全矩阵；修订快速通道（含 N19 判定）                                                                                                                                                                                                                          |
| **P2** | 数据流面：数据流账（上下文世代域 + 继承语义 + 版本号 + 屏障）、条件预授权运行时裁决、**世代级知情豁免（含 A2a 同步失效 + A2b 知情文案）**、SecretRef 句柄绑定 + L1 代签（含签名策略校验 + wire format 唯一构造 + maxUses）/ L2 令牌 / L3 注入、出站检查、引用型 sink inline / 哈希钉版 + realpath 规范化、**derived label overlay 管理器（含 A1a 触发轴 + A1b 层级轴 + A1c 生存期轴 + N20 清除解耦）** |
| **P3** | 沙盒后端链 + 能力封顶（V15 修正）+ symlink 加固；Deployer 按 Domain/Role/凭据绑定；egress proxy；kill switch（含 task-scratch 清理钩子）                                                                                                                                                                                                                                                                           |
| **P4** | TCB 治理（T1–T8）：版本签名、注册表边界化、回归语料与对抗用例（含**canonical form 攻击 / wire 构造者绕过 / derived label 漂移 / overlay 移动逃逸 / 世代级确认失效竞态**）、红队流程；信任阶梯状态机（含行为签名形式化 + 小样本集合比较）；授权通胀遥测；审批呈现责任声明 + 基线偏移 SLO；**负例条目策展全量回归**                                                                                     |
| **P5** | 根信任治理：签名方案、审批人认证、审计只追加签名链（根派生本地子密钥 + checkpoint）+ 外部锚、撤销注册表与紧急撤销流程、根信任锚自举；审计 checkpoint 窗口残余声明                                                                                                                                                                                                                                                  |
| **P6** | 执行协议整合：session≡goal / turn≡task 归因、并发快照共享与账本线性化、修复回路 E2E                                                                                                                                                                                                                                                                                                                              |
| **P7** | 形式化与属性测试：TLA+/Alloy 规格（含 V17、N7、N11、N12、N16–N20）、属性测试基线、区分「已证/已测/已审」保证等级                                                                                                                                                                                                                                                                                                  |

**测试基线**：

- `GATEWAY_PIPELINE_STAGES` 逐阶段断言；
- 能力注册类型校验；
- 优先序矩阵（V17 > R5 等；**overlay 不参与 hard 层**）；
- 句柄旁路对抗用例（generic egress 收句柄必拒/透传）；
- 签名策略校验（越权请求必拒）；
- canonical form 攻击 + wire 构造者绕过（代签器唯一构造）；
- maxUses 重放；
- 条件预授权时序（账本原子性 + 缺事件破缺 + 世代域跨 Turn + 自动压缩继承 + **世代级确认同步失效**）；
- 账本屏障竞态用例；
- 引用型 TOCTOU 用例（inline 免疫 / 哈希钉版拒 `REFERENCE_DRIFT` + realpath 规范化）；
- **overlay 触发轴（断流不产生 / 未断流产生 / 求值点 ⑩）**；
- **overlay 移动逃逸（`fs.copy`）**；
- **overlay 层级边界（不驱动 hard 层）**；
- **overlay 生存期（workspace manual-clear / sandbox 随域销毁）**；
- **overlay 清除解耦（flush 不清 overlay）**；
- 代签降级攻击 / 令牌重放；
- 阶梯状态机全转移（含行为签名 `D_KL` 判据 + 小样本集合比较）；
- TCB 钉版快照不可变性；
- 审计链篡改检测、撤销注册表时效性；
- kill × task-scratch 清理；
- 模式冲突裁决（secret 不可降级 + **负例条目出口** + sensitive 以下用户优先 + 压制审计 + 聚合呈现）；
- 快速通道判定（边界集/secret 求交）。

---

## 17. 最小可行子集

全量实现成本高。以下为**安全不可裁剪的核心**与**可裁剪的增强**。

### 17.1 不可裁剪（核心）

| 项                                      | 理由                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| 三原语 + 六规则 + 优先序（§4）         | 语义正确性基础；裁剪即语义错误                          |
| 派生流程 + 钉版快照（§5）              | 无钉版则策略变更不可归因                                |
| R3-hard 断流（secret 必断流，§6）      | secret 泄漏不可接受                                     |
| 自动压缩继承账本（N11）                 | 世代清洗攻击是致命绕过                                  |
| N4 句柄绑定 + generic egress 永不解析   | 句柄旁路是致命绕过                                      |
| N16 代签器唯一构造 wire format          | 无此则 L1 安全声明建立在解析器无歧义的假设上            |
| N12 签名策略校验                        | 无策略校验则 L1 退化为盲签                              |
| V17/V8/V13（hard 层 + fail-closed）     | 安全底线                                                |
| V15 默认 forbidden（不可强制轴）        | 无强制即无执行；gated 单独不够                          |
| 根层签名 + 审计只追加（§9.5 的最小版） | TCB 不能自证；审计不可篡改是事后归因基础                |
| 账本域 = 上下文世代（N7）               | Turn 域漏判可被利用                                     |
| 账本版本 + 屏障（N8）                   | 竞态可绕过条件裁决                                      |
| **N17 overlay（A1 三轴修正版）**  | **workspace artifact 中继是结构性缺口；成本极低** |
| **N20 overlay 清除解耦**          | **防止 flush 逃逸阀在数据残留层重开**             |

### 17.2 可裁剪（增强）

| 项                 | 裁剪后替代                                         | 风险                           |
| ------------------ | -------------------------------------------------- | ------------------------------ |
| 信任阶梯 T1/T2     | 全部 external 保持 T0                              | 审批疲劳，但安全               |
| R3-flow 条件预授权 | sensitive 亦走 R3-hard 静态钳制（strict 档）       | 更多摩擦，更保守               |
| L1 代签 / L2 令牌  | 全部走 L3 原文注入 + 根层签署 L3 例外              | 原文暴露面更大，需审计一等事件 |
| 行为签名形式化     | 仅用「零 danger/boundary 事件 + 固定窗口」简化判据 | 防慢速投毒弱化                 |
| 引用型哈希钉版     | 强制 inline 投影（大 payload 场景性能受限）        | 大 payload 场景可用性下降      |
| 继承完整事件集     | 布尔摘要降级（审批摘要归因弱化，显式声明）         | 归因弱化                       |
| 世代级知情豁免     | 每次 egress 恒审批                                 | 审批疲劳，可能诱导 flush 逃逸  |
| 形式化（§15.1）   | 仅属性测试 + 金测                                  | 保证降为「已测」               |
| 外部锚             | 仅本地签名链                                       | 篡改检测依赖本地完整性         |
| Session 账本域配置 | 固定上下文世代                                     | 无                             |
| Windows 后端       | 仅 Linux/macOS                                     | 平台受限                       |
| 授权通胀遥测       | 仅靠 PRESETS                                       | 宽授权激励仍在                 |

### 17.3 最小架构

```
根信任锚（HSM 单密钥 + 本地签名链）
  → GrantStore(签名根授权)
  → PolicyResolver(meet + R1–R6 + 优先序 + 全对 R3-hard/flow + V17 + V15-forbidden)
  → ToolGateway(11 阶段 + 账本版本屏障 + 世代继承 + 代签器唯一构造 wire + 出站检查
                + inline 投影 + derived label overlay(上限 sensitive / manual-clear))
底部: 标注注册表(含负例条目) · 沙盒后端(Linux bwrap/Landlock, macOS Seatbelt)
      · egress proxy · 数据流账(上下文世代 + 继承事件集 + 版本号)
      · Derived Label Overlay 管理器
```

### 17.4 升级路径

P0–P3 → P4（TCB 治理）→ P5（根信任）→ P6（并发线性化）→ P7（形式化）。**建议**：即便裁剪，P2 的**世代继承 + overlay 三轴修正 + 版本屏障 + 代签器唯一构造 wire format + 签名策略校验**与 P5 的**根签名 + 审计链**应尽早落地。

## 附录 A：设计来源

| 来源                             | 吸收                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三段生命模型                     | 根授予一次、派生每契约一次、执行每次调用                                                                                                                                                                                                                                                                                                                                                    |
| 三问公理                         | 后果时点、数据流方向、行动空间扩展的生成式风险模型                                                                                                                                                                                                                                                                                                                                          |
| 枢纽公理                         | 模型上下文是万能中转枢纽；source 危险性与升权柔性成正比                                                                                                                                                                                                                                                                                                                                     |
| 上下文世代公理                   | 敏感残留随上下文生命周期而非 Turn 生命周期消散                                                                                                                                                                                                                                                                                                                                              |
| 世代切换保守继承                 | 自动压缩继承账本，堵死模型驱动的账本清洗路径                                                                                                                                                                                                                                                                                                                                                |
| 世代级知情豁免                   | 摩擦从「清记忆」精确化为「知情豁免」，消除注入诱导的 flush 逃逸阀                                                                                                                                                                                                                                                                                                                           |
| Derived Label Overlay            | workspace artifact 中继缓解；数据残留与上下文残留同属追踪范围                                                                                                                                                                                                                                                                                                                               |
| 代签器唯一构造 wire format       | P21 解析器语义一致性；消除 canonical form 攻击面                                                                                                                                                                                                                                                                                                                                            |
| 守恒律                           | 摩擦在 source / sink 两端分配；条件预授权延迟到共现时刻                                                                                                                                                                                                                                                                                                                                     |
| 冲突可串行化 / action graph      | 并行性公理与工程同构                                                                                                                                                                                                                                                                                                                                                                        |
| TCB / 高 assurance 实践          | 策略供给链版本化、回归语料、红队、钉版快照、根信任锚                                                                                                                                                                                                                                                                                                                                        |
| 形式化方法 / 属性测试            | 已证 / 已测 / 已审三级保证                                                                                                                                                                                                                                                                                                                                                                  |
| **四轮评审（v1.0–v1.3）** | **世代清洗、代签盲签、V15 错配、授权通胀、引用型 TOCTOU、boundary 策展、审批呈现层、Label 冲突裁决、chat egress、kill × task-scratch、V17 形式化、D_KL 小样本、审计签名瓶颈、版本号映射、canonical form、artifact 中继、继承粒度、摩擦经济学、N15 压制、快速通道判定、SLO 基线偏移、checkpoint 窗口残余、realpath 规范化、overlay 三轴、确认同步失效、知情文案、负例条目、压制聚合** |

---

**文档结束**。本设计以三问公理为生成基础，以六规则 + 优先序（含 P24 显式分层）为语义核心，以数据流账（上下文世代 + 保守继承 + 世代级知情豁免 + 版本屏障）与 derived label overlay（三轴修正：断流兑现 / 上限 sensitive / manual-clear + 清除解耦）为流控制机制，以 SecretRef 三级解析（含签名策略校验 + 唯一 wire format 构造）为断流实现，以 TCB + 根信任锚为策略正确性保障，以信任阶梯 + 行为签名为外部工具治理，以三级保证为正确性声明。**承诺无旁路，不承诺策略无误；域外风险由独立治理面承担；签名策略宽度、审批人判断质量、显式持久化外部数据、overlay 精确性不在系统承诺内。**
