# Agent Harness 权限系统 v3 — 实现设计文档

**基于**：`docs/core/AHF_CORE_AUTHORIZATION_V3.md`（设计定稿）
**状态**：实现对齐稿
**范围**：定义 v3 授权语义层与执行网关的模块划分、公开 API、错误/审计契约与测试基线。代码位于 `packages/core/src/authz/`，以命名空间 `authz` 从 `@mazi/core` 导出。

---

## 1. 精简边界

v3 相对 v2 的裁剪（对应设计文档附录 B）在实现层表现为：

- 删除 26 条原则 / 20 条不变量编号体系，规则以“三问 + 底线钳制”重新表达；
- 删除信任阶梯（T0/T1/T2）、KL 散度判据、行为签名；
- 删除三级解析阶梯（L1/L2/L3）与能力令牌，只保留网关唯一构造与代签（原 L1 语义）；
- 删除动词规则表作为风险主依据，只保留 Q1 值层识别（`rm`/DDL/删除等）；
- 删除世代级知情豁免、双人规则、重复扣款防护；
- 合并模块：`overlay` 并入账本，`roles/verbs/boundary/rules` 收敛为三问求值器，`root-trust/audit` 收敛为签名链，`secret-ref/dataflow` 收敛为断流与出站投影。

## 2. 模块与公开 API

| 模块 | 职责 | 文档锚点 |
| --- | --- | --- |
| `glob.ts` | `**`/`*`/`?` 路径匹配、specificity、`~` 展开 | §5.2 |
| `hash.ts` | 稳定序列化与内容版本 | §6.1 |
| `labels.ts` | 标注注册表：平台秘密/边界/负例条目 + 用户条目；未标注=internal，存疑=sensitive | §5.3, §6.3.2 |
| `risk.ts` | 三问求值器（Q1/Q2/Q3）+ Q1 值层识别 + 边界写判定 | §5.1, §5.2, §5.5 |
| `derive.ts` | 派生：meet + 三问下限 + 底线钳制 + 不可变快照钉版 | §6.1 |
| `ledger.ts` | 周期账本：版本全序、INV-A/INV-B、继承/重置、残留污点表 | §6.3, §6.4, §6.5 |
| `egress.ts` | 出站值投影、引用型钉版（inline/哈希） | §6.3 实现纪律 |
| `secret.ts` | 秘密断流 + 策展属性代理 + 券不透明 + 网关唯一构造/代签 | §6.2, §6.2.1 |
| `approval.ts` | 审批回显与摘要（系统责任止于摘要生成与签名） | §6.3, §7 底线 4 |
| `trust.ts` | Ed25519 签名者 + 只追加签名链 + 外部锚 | §7 底线 4 |
| `telemetry.ts` | R（审批必要率）/ F1 / F2 | §6.3.3 |
| `sandbox.ts` | 沙盒/出网代理接口与缺件 fail-closed | §7 底线 2 |
| `gateway-types.ts` | 网关契约：注册、调用、三态结果、审批 seam、审计事件、阶段 | §8 |
| `gateway.ts` | 执行网关管线（范围 → 三问 → 账本裁决 → 代签/属性 → 沙盒 → 记账/污点 → 审计） | §8 |
| `index.ts` | 命名空间导出 | — |

## 3. 关键契约

### 3.1 三问（`risk.ts`）

```ts
assessQuestions({ capability, semantics, projection, target }): QuestionAssessment
// Q1 命中 → 下限 gated；Q3 命中 → 下限 gated；Q3 + secret → forbidden
```

- **Q1**：`semantics.irreversible` 或值层识别命中（`rm`/shred/`dd of=/dev/`/DROP/无 WHERE DELETE/force push）→ 不可撤回；
- **Q2**：`semantics.ingest` 为真 → 内容置入上下文；secret 必须断流；
- **Q3**：写入目标落入边界集（authorized_keys、crontab、shell rc、CI/hook、harness 自包络）或 `semantics.envelope` → 修改权限包络。

### 3.2 派生（`derive.ts`）

```ts
derive(root: Grant, request: TaskRequest, ctx: DeriveContext): DeriveResult
// 未声明能力 = forbidden；meet 逐轴取严；三问下限与底线钳制不参与 meet、不可放宽
```

`EffectivePolicy.capabilities[*].tier` 由 `strictestTier(meet, floor, hard)` 得出；快照钉住 `pinned: { labels, rules, trust }`。

### 3.3 账本与出站裁决（`ledger.ts`）

```ts
ledger.commit({ label, source, stepId }): LedgerVersion   // INV-A：先提交后返回
ledger.adjudicate(): { broken; sources; version }          // INV-B：读最新已提交
ledger.recheck(version): boolean                           // 裁决后新提交 → 重新裁决
ledger.switchPeriod('session-created' | 'user-reset' | 'auto-compaction' | 'session-destroyed')
taint.markFromLedger(target, ledger)                       // 机制五
taint.clear(target, attestor, reason)                      // 与重置解耦
```

### 3.4 断流与代签（`secret.ts`）

```ts
service.sever({ refId, allowedSinks, purpose, value, profile? }): SeveredSecret
// 原文只进 TCB；返回 { handle, ref, attributes }，属性仅取自策展集（INV-C）
service.resolve(refId, tool, invocation): ResolveOutcome
// 校验 tool ∈ allowedSinks → service/action/resource 匹配 purpose → 网关构造 wire 并签名
```

## 4. 错误码

```ts
type AuthzErrorCode =
  | 'FORBIDDEN_UNREGISTERED' | 'FORBIDDEN_BY_POLICY' | 'FORBIDDEN_BY_HARD_FLOOR'
  | 'INVALID_ARGS' | 'GATED_PENDING' | 'GATED_REJECTED' | 'APPROVAL_UNAVAILABLE'
  | 'BUDGET_EXHAUSTED' | 'EXECUTION_FAILED' | 'SANDBOX_UNAVAILABLE'
  | 'LEDGER_UNAVAILABLE' | 'EGRESS_BLOCKED'
  | 'HANDLE_REFUSED' | 'HANDLE_PASSTHROUGH' | 'SIGN_POLICY_VIOLATION'
  | 'REFERENCE_DRIFT' | 'DERIVE_REJECTED';
```

所有拒绝为结构化 `{ code, hint }`，禁止裸 deny。

## 5. 测试基线

| 文件 | 覆盖 |
| --- | --- |
| `authz-labels.test.ts` | 秘密/边界/负例/默认 internal/用户条目 |
| `authz-risk.test.ts` | Q1/Q2/Q3 判定与下限 |
| `authz-derive.test.ts` | meet 单调收紧、未声明 forbidden、三问下限、底线钳制、钉版快照 |
| `authz-ledger.test.ts` | 版本、INV-A/INV-B、周期继承/重置、投影记账、污点施加/清除解耦 |
| `authz-secret.test.ts` | 白名单、purpose 越权必拒、唯一构造、属性策展（INV-C） |
| `authz-egress.test.ts` | 出站账本裁决、券不透明、引用钉版漂移 |
| `authz-telemetry.test.ts` | R / F1 / F2 |
| `authz-trust.test.ts` | 签名链完整性、篡改检测、外部锚 |
| `authz-gateway.test.ts` | 端到端：tier 分派、三问、审批、账本记账、污点 |

## 6. runtime 接线

`packages/runtime/src/tool-gateway/permission.ts` 将 UI 权限档位映射为 root `Grant`（`caps`），按 `ToolConfig` 推导能力与三问语义，装配 `DataflowLedger` + `TaintTable` + `DefaultToolGateway`。`approval.ts` 保持 `ApprovalSeam` 契约；`policy-audit.ts` 按新阶段集合压缩审计事件。
