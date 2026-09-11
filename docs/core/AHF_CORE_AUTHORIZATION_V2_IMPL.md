# Agent Harness 权限系统 v2 — 实现设计文档

**基于**：`docs/core/AHF_CORE_AUTHORIZATION_V2.md`（设计定稿，v1.3）
**状态**：实现对齐稿
**范围**：本文定义 v2 授权语义层的模块划分、公开 API、错误/审计契约与测试基线。强制执行行为面（11 阶段管线）由 `docs/core/AHF_CORE_TOOL-GATEWAY.md` 定义，本模块向其提供 `EffectivePolicy` 快照与运行时裁决器。

---

## 1. 分层与边界

- **数据语义层（本文）**：三原语（Domain/Label/Role）、六规则、派生、账本、overlay、SecretRef、TCB/根信任。
- **执行层（ToolGateway）**：11 阶段管线消费本模块产物；本模块不实现沙盒与 handler。
- 代码位置：`packages/core/src/authz/`（TCB 语义层）。`@mazi/core` 以命名空间 `authz` 导出，避免与既有 v1 契约（`authorization.ts`/`tool-gateway.ts`）的 `AgentGrant`/`EffectivePolicy` 等同名类型冲突。
- 依赖方向：`authz/*` 只依赖自身与 `node:crypto`（根信任/审计签名）。不依赖 runtime/apps。
- **v1 契约清除（本次）**：旧的 `authorization.ts`（EffectClass 等）、`approval.ts`（ApprovalSeam）、`tool-gateway.ts`（v1 11 阶段/EffectClass 契约）已删除。仍被 goal 模型/运行时配置/观测契约使用的 `PermissionLevel`、`SideEffectScope`、`ApprovalScope` 迁移到 `permissions.ts`；网关审计桥的 effectClass 字段改为 `string`（即 v2 CapabilityKey）。

## 2. 模块与公开 API

| 模块 | 职责 | 文档锚点 |
| --- | --- | --- |
| `glob.ts` | `**`/`*`/`?` 路径匹配、specificity 计算、`~` 展开 | §4.2 |
| `labels.ts` | 内置标注 + 负例条目 + N15 冲突裁决 + 压制聚合 + derived overlay 参与 | §4.2, §7.2, N15, B1–B3, P24 |
| `roles.ts` | 三轴角色 + 可逆凭据 + 后端能力矩阵（V15） | §4.3, §4.4, V15 |
| `rules.ts` | R1–R6 下限求值器 + hard 层（V17/V13）+ 优先序（P24） | §4.4, §4.5, V8, V17 |
| `tcb.ts` | 注册表内容哈希/版本 + 派生钉版快照 | §9.4 T1/T2/T6 |
| `root-trust.ts` | Ed25519 根签名/验签、密钥轮换、撤销注册表 | §9.5.1, §9.5.4, N10 |
| `audit.ts` | 只追加签名链、checkpoint、外部锚、回放验证 | §9.5.3, §11, N10 |
| `ledger.ts` | 上下文世代账本：版本全序、屏障、继承、世代级知情豁免（A2a/A2b） | §1.3.3, §6.5, N7/N8/N11/N18 |
| `overlay.ts` | Derived Label Overlay：A1a/A1b/A1c 三轴 + N20 清除解耦 | §6.8, N17, N20 |
| `secret-ref.ts` | 三级解析、L1 签名策略校验 + 唯一 wire 构造 + maxUses、L2 令牌与撤销、L3 注入 | §6.3, §6.4, N4/N9/N12/N16 |
| `dataflow.ts` | 出站值投影探测、引用型 sink inline/哈希钉版 + realpath（N13） | §6.2, §6.6, N13 |
| `boundary.ts` | 边界集资产 + R5 触发 + 快速通道判定（N19） | §7.3, §12, N19 |
| `verbs.ts` | 动词匹配器 → 语义角色重派（rm/DROP/…） | §7.1 |
| `escalation.ts` | V12 偏序短路（严格更宽判定） | §12, V12 |
| `derive.ts` | meet + 角色下限 + 边界 R5 + 全对 R3 + hard 终裁 + V15 封顶 + 快照 | §5, V3/V4/V7, §5.3 |
| `trust-ladder.ts` | T0/T1/T2 状态机 + 行为签名 + 稳定性判据 + 即时降级 | §4.6, N6 |
| `approval.ts` | V18 审批回显、审批令牌绑定、重复扣款防护、双人规则 | §9.5.2, §12, V18, §8.2 |
| `engine.ts` | 组合根 `AuthorizationEngine`：derive / resolveAsset / ⑩ overlay / 条件裁决 / 见证 / flush | §17.3 |
| `telemetry.ts` | 授权面宽度遥测 | §9.4 T7 |
| `audit.ts` | `DECISION_EVENT_TYPES` 事件目录 | §11 |
| `types.ts` | 上述共享类型 | §4 |

## 3. 关键契约

### 3.1 标注裁决

```ts
resolveAssets(query: AssetQuery, registry: AssetLabelRegistry): ResolvedLabel
// ResolvedLabel = { label, boundary, specificity, matches, suppressed, fromOverlay }
```

- secret 级平台强制不可降级：用户降级声明被压制，并产出 `label-resolution` 压制事件。
- 负例条目（`origin: 'platform-curated-negative'`）为 secret 降级的合法出口；匹配时剔除其覆盖的更宽 secret 标注，回落 internal。
- sensitive 及以下：取最严 Label → 更具体 pattern → 用户 origin。
- boundary 取并集。
- overlay 以 specificity=∞ 参与，但 `fromOverlay=true` 时只收紧 flow 层（P24）。

### 3.2 派生产物

```ts
derive(parent: AgentGrant, request: TaskPolicyRequest, ctx: DeriveContext): DeriveResult
// DeriveResult.ok=false → { reason, revision }（fail-fast，不 spawn）
// EffectivePolicy = { capabilities, ruleHits, conditions, pinned, ledgerDomain, derivedFrom }
```

钳制次序：meet → R1/R2/R4/R6 → R5 边界 → R3 全对（hard 钳制/flow 条件）→ V17/V13 → V15。

### 3.3 账本与条件裁决

```ts
ledger.commit(write: LedgerWrite): LedgerVersion        // 原子提交点
ledger.barrier(timeoutMs): LedgerSnapshot              // 等待已发起写提交；超时 fail-closed
ledger.snapshot(version): LedgerSnapshot               // 全序前缀
ledger.switchGeneration(trigger): GenerationResult      // 继承/清账/归档
verdict(snapshot, condition): 'satisfied' | 'broken'   // 缺事件按破缺（N5）
```

世代级知情豁免：签署记录 `ledgerVersion`；`isAttestationValid(att, snapshot)` 同步计算前缀中是否存在晚于该版本的 ≥sensitive 读。

### 3.4 SecretRef

```ts
resolve(ref: SecretRef, request: ResolveRequest, deps: ResolverDeps): ResolveOutcome
// L1: gatewaySign(ref, invocation) —— 策略校验 → maxUses → constructWire → sign
// L2: issueCapabilityToken(ref, ttl<=60s, 撤销表)
// L3: 需根层签署 L3 例外 → injectToProcess
```

## 4. 错误码

```ts
type AuthzErrorCode =
  | 'FORBIDDEN_UNREGISTERED' | 'FORBIDDEN_BY_POLICY' | 'FORBIDDEN_BY_HARD_LAYER'
  | 'GATED_PENDING' | 'APPROVAL_UNAVAILABLE' | 'BASE_UNAVAILABLE_DENIED' | 'SANDBOX_UNAVAILABLE'
  | 'POLICY_REVOKED' | 'LEDGER_BARRIER_TIMEOUT' | 'LEDGER_UNAVAILABLE'
  | 'HANDLE_REFUSED' | 'HANDLE_UNRESOLVABLE' | 'SIGN_POLICY_VIOLATION' | 'SIGN_MAX_USES_EXCEEDED'
  | 'TOKEN_REVOKED' | 'REFERENCE_DRIFT' | 'EGRESS_SENSITIVE' | 'DERIVE_REJECTED';
```

所有拒绝为结构化 `{ code, hint }`，禁止裸 deny。

## 5. 测试基线（对应 V2 §16）

按模块的测试文件（`packages/core/test/authz-*.test.ts`）：

| 文件 | 覆盖 |
| --- | --- |
| `authz-labels.test.ts` | N15 secret 不可降级 + 负例出口 + 用户优先级 + boundary 并集 + 压制审计/聚合 |
| `authz-rules.test.ts` | 优先序矩阵（V17>R5；overlay 不进 hard）+ R1–R6 + V15 凭据回落 |
| `authz-derive.test.ts` | meet 单调收紧 + 全对 R3-hard/flow + 快照/ruleHits + V12 偏序 + 快速通道 N19 |
| `authz-ledger.test.ts` | 世代域 + 继承（完整/布尔）+ flush 清账 + 版本屏障 + 超时 fail-closed + A2a 同步失效 |
| `authz-overlay.test.ts` | A1a 触发轴（断流不产生/未断流产生/⑩ 含本次读）+ A1b 上限/不驱动 hard + A1c 生存期 + N20 解耦 |
| `authz-secretref.test.ts` | 白名单 + 签名策略越权必拒 + canonical form + maxUses 重放 + L1>L2>L3 + 撤销 |
| `authz-dataflow.test.ts` | 出站探测 + inline 免疫 + 哈希钉版 REFERENCE_DRIFT + realpath 规范化 |
| `authz-tcb.test.ts` | 钉版快照不可变 + 审计链篡改检测 + 撤销后钉版 fail-closed + 根签名轮换 |
| `authz-trust-ladder.test.ts` | 全转移覆盖 + 小样本集合比较 + D_KL 边界 + 跨版本回落 T0 |
| `authz-engine.test.ts` | 组合根 E2E：sensitive 读→写 artifact→overlay→egress 破缺 + flush/overlay 解耦 + A2a 同步失效 + T7 遥测 + 重复扣款 + N8 重读 |

## 6. 非目标（本文不实现）

- 沙盒后端（bwrap/Landlock/Seatbelt）与 Deployer profile 生成；
- egress proxy 的网络实现（仅定义域名校验接口）；
- 11 阶段管线的编排（ToolGateway 文档范围）；
- 形式化 TLA+/Alloy 规格（V2 §15.1）。
