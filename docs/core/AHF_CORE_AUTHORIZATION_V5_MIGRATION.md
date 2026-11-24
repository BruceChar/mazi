# Agent Harness Auth v5 — 迁移改造清单

**基于**：`docs/core/AHF_CORE_AUTHORIZATION_V5.md`（设计定稿）
**现状**：已实现 V3（`packages/core/src/authz/` + `packages/runtime/src/tool-gateway/`、`runtime/src/auth/`）
**定位**：从 V3 已实现代码到 V5 的任务分解与现状映射；设计语义以 V5 正文为准，本文档不重复设计论证。
**纪律**：文档先行 → 测试先行 → 代码；每个里程碑独立可提交、可验收。

---

## 0. 落地进度（core 决策内核已完成）

已在 `packages/core/src/authz/v5/` 落地纯函数决策内核，全部带测试，未改动 V3 旧导出（旧 158 项 authz 测试无回归）：

| 模块 | 文件 | 对应里程碑 |
| --- | --- | --- |
| 七行 decide / B1–B4 / hazard | `v5/decision.ts` | M1 |
| 命令拆链 / 七类分类 / TOCTOU | `v5/parser.ts`、`v5/classify.ts` | M2 |
| 指纹记忆（作用域/内容哈希） | `v5/fingerprint.ts`、`v5/memory-store.ts` | M3 |
| 直通 attest / 红线 | `v5/attest.ts`、`v5/blocked-store.ts` | M4 |
| 审批响应集合 settle | `v5/approval.ts` | M5（core 契约） |
| 留痕 / 纠正闭环 / 降档 | `v5/trace-store.ts`、`v5/correction.ts` | M6 |
| 运行清单 / 非交互 fail-closed | `v5/runbook.ts` | M7 |
| 强制层放行域矩阵 | `v5/enforce-level.ts` | M8 |
| 目标轴 routine 模型 | `v5/routine-model.ts` | M9 |
| 决策审计记录 / 红队 17 项 | `v5/audit.ts`、`test/authz-v5-redteam.test.ts` | M10 |

**runtime 已落地（适配层，旧 v3 装配未动）**：

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 工具调用 → v5 Op 映射 + `v5Decide` | `runtime/src/tool-gateway/v5-adapter.ts` | R1，保守映射，object 缺省 unknown |
| 决策上下文组装（memory/blocked/routine/correction/trace → `DecisionContext`） | `runtime/src/tool-gateway/v5-context.ts` | R2，v5 网关切换装配入口 |

**R3 已落地（API 审计端点 + WebUI 面板，旧档位选择器已移除）**：

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 审计端点 | `apps/api/src/permissions/permissions.controller.ts` | `GET /api/permissions/audit`，rootGoalId 优先（replay 根流），否则 sessionId（回放锚点流）；actor/result/tool/keyword 筛选 |
| 前端筛选/汇总纯逻辑 | `apps/webui/src/scripts/permission-audit.ts` | 角色/结果/工具/关键词/时间范围过滤 + 计数，带 vitest |
| 审计面板 | `apps/webui/src/components/PermissionAuditPanel.vue` | 右侧栏「权限」页签：角色（用户/Agent/系统）、结果（批准/拒绝/自动放行/待审批/取消/撤销/命中）、决策依据、作用域、goal/step 锚点，可筛选 |
| 档位选择器下线 | `Composer.vue`、`SettingsPage.vue`、`ChatMain.vue`、`App.vue` | 六档菜单、默认授予 select 及透传 props/emit 全部删除 |

**待接线（下一阶段，需先写集成测试再改装配）**：

1. runtime 网关切换：`RuntimeToolGateway` 改用 `v5Decide` + `V5RuntimeContext`；物理删除 `grantForPermissionLevel` 六档与 `derive` 档位 meet；`permission-gateway.test.ts` 同步重写（产品可见变更，需先确认档位 UI 去留）。
2. API：`approvals.controller.ts` 结算字段扩展（拒绝进红线 / typedConfirm / correction），经 `settleApproval` 落 memory/blocked。
3. WebUI（档位选择器已移除、审计面板已上线）：`ApprovalPrompt.vue` 改响应集合；新增"最近自动执行"留痕面板。
4. 解析器接入真实 git 事实（tracked / dirty / gitignore）与 shell 完整语法。

---

## 1. 现状与目标对照

### 1.1 沿用不动（机械骨架）

| 现有模块 | 现状 | v5 去向 |
| --- | --- | --- |
| `core/src/authz/secret.ts` | 秘密断流、voucher、网关代签 | 沿用 B1；进程内残余由强制层兜底（§6 B1 残余披露） |
| `core/src/authz/ledger.ts` | 敏感读账本 INV-A/INV-B、残留污点表 | 沿用；补"污点会话批准事件不进模型"的输入隔离（§9） |
| `core/src/authz/trust.ts` | 哈希链 + Ed25519 签名 + 外锚 | 沿用 D19 |
| `core/src/authz/risk.ts` | 三问求值器（Q1/Q2/Q3） | 沿用为 hazard 谓词组件；学习对三问无写权限 |
| `core/src/authz/labels.ts` | 敏感级/boundary 静态标注 | 复用为对象分类器输入，不直接当 hazard 依据 |
| `core/src/authz/egress.ts` | 引用型钉版 | 沿用，并入 TOCTOU 重校验 |
| `core/src/authz/sandbox.ts` | 沙盒/代理 seam 抽象 | 扩展为 `enforce_level()` 矩阵（§11） |

### 1.2 重写

| 主题 | 现状 | v5 去向 |
| --- | --- | --- |
| 决策链 | `gateway.ts` 九阶段管线，gated 来源混合（档外/Q1Q3/trust/账本破缺/alwaysPrompt） | 七行 `decide()`，顺序即优先级（§1/D2） |
| 档位模型 | `permissions.ts` 六档 + `runtime/tool-gateway/permission.ts#grantForPermissionLevel` 批量授权 | 删除；单级别 auto（D1） |
| 预授权记忆 | `gateway-types.ts#ApprovalStore` 进程内 key 记忆（once/session/workspace，重启即失） | 指纹记忆：归一化 + 目标绑定 + 内容哈希（§8/D14） |
| 命令分类 | `command.ts` 只 token 分类（dangerous/readonly/network/unknown） | 解析器拆链 + 对象分类（§4/D12） |
| 度量 | `telemetry.ts` 只测 R/F2，无闭环 | 纠正闭环 + 纠正率自动降档（§10/D8） |

### 1.3 全新

blocked 红线层、passthrough 直通、学习层 routine、纠正闭环、复合命令拆链原子语义、TOCTOU 执行前重校验、运行清单、留痕视图、强制层放行域矩阵。

---

## 2. 设计立场备忘（实现期不得回退）

评审疑问：`net.fetch`、`fs.write` 等常规操作为什么不做类别级开箱 auto？

- **工作区读**：唯一无门槛 auto（auto_log，§4 读默认规则）。
- **fs.write（工作区源码/产物）**：非 hazard，首次 default ask；批准后指纹 once/session，同 `(action, object_class, target_binding)` 5+ 次零纠正低方差后 routine auto。不是永远问。
- **net.fetch（新目标）**：`egress + target_fresh` → hazard（§5），至少问一次；无网络强制层时指纹限 once、不进例行；有代理白名单后才可 session 记忆/例行（§11）。
- **禁止类别级默认放行**："这类都放行"即类别泛化，是 v9.3 时序投毒缺口的根治对象（§5/D3）。V3 档位本质就是一次大型类别批量授权，D1 移除的正是它。实现期不得用"常规无风险"为由恢复整类 auto；放宽只能走 passthrough 当次点名、显式逐条授权、指纹、例行四条通道。

---

## 3. 里程碑 TODO

> 依赖：M1 与 M5 必须同批交付——档位一移除而无 memory/routine 填充，所有操作都会落 default ask。学习层 M9 按 §15 后置。

### M1 决策链骨架（七行）

- [ ] 新增 `decide(op)` 七行链：bottom → blocked → hazard → passthrough → memory → routine → ask，替换 `gateway.ts` 九阶段中的 gated 判定
- [ ] B1–B4 机械谓词落码：秘密断流、系统毁灭、污点出站、元操作/学习模型写保护（B4 扩展到模型文件与阈值）
- [ ] hazard 最小集：`irreversible/unproven`、`critical`、`external` 读写删执行、`envelope`
- [ ] 沿用 `risk.ts` 三问、`secret.ts` 断流、`ledger.ts`、`trust.ts`，契约不改
- **文件**：`core/src/authz/gateway.ts` 重写；新增 `decision.ts`、`hazard.ts`
- **验收**：§16 #15（读 `.env` B1 deny）、#16（Agent 通道写模型 B4 deny+审计）、#20（工作区读 auto_log）机械断言通过

### M2 Op 解析与对象分类

- [ ] `parse() -> [Op]`：管道/重定向/命令替换/多行拆成完整 op 链；任一 op 落 ask 未获批 → 整链暂停（原子语义）
- [ ] 拆不动 → `unparsed` hazard + 不可指纹化；`sh -c`/`python -c` 内联解释器整条 hazard
- [ ] `classify(target)` 七类：build_artifact / source / source_dirty / sensitive / external / critical / unknown；gitignore 命中、git tracked、未提交改动检测；unknown 按 irreversible 对待
- [ ] envelope 能力边界判定（拿不准 → true），路径清单只作提示不作判定
- [ ] TOCTOU：每 op 落盘/spawn 前重新分类；目标变 external/critical 或 symlink 变更 → 回 hazard；执行类绑脚本内容哈希
- **文件**：`command.ts` 扩展；新增 `parser.ts`、`classifier.ts`；复用 `labels.ts`、`egress.ts`
- **验收**：§16 #19（`sh -c` 每次必问不可指纹化）、#25（复合命令先获全部批准再执行、逐 op 重校验）

### M3 指纹记忆（替换预授权）

- [ ] 指纹 = 归一化命令行（realpath/空白/引号等价，歧义即新指纹）+ 目标绑定（host/收件人/分支+远端）+ 内容哈希（执行类绑脚本哈希、envelope 绑目标文件哈希，被绑对象改动即失效）
- [ ] 作用域 once/session/project；hazard 不可逆/envelope 禁 project 之外；不可逆 project 需键入确认；all 仅非 hazard 且显式开启 + 键入确认
- [ ] 解析器/分类器版本变更 → 相关指纹失效重估；持久化存储替代 `InMemoryApprovalStore`（现状进程内存、重启即失）
- [ ] 设置中可见、逐条撤销、可过期
- **文件**：替换 `gateway-types.ts#ApprovalStore`；新增 `fingerprint.ts`
- **验收**：§16 #1（`rm -rf dist/` 首次问→once）、#7（`~/.bashrc` 内容哈希）、#8（改 ci.yml 指纹失效）、#13（`git push --force` 例行不覆盖）

### M4 直通 + 红线

- [ ] passthrough：`attested ∈ {verbatim, derived}` + `channel=ui_user` + `round_clean` + 非 hazard；hazard 点名仍问一次并标注"来自你的指令"；当次有效不落记忆
- [ ] blocked：显式拒绝记忆，点名也问一次
- [ ] 意图锚定器（`attest(op)`）独立评审：UI 可信侧签发一次性意图绑定令牌；"按 README 执行" → `attested=none` → 默认弹窗
- **文件**：新增 `attest.ts`、`blocked-store.ts`
- **验收**：§16 #10（逐字"跑 npm test"直通当次）、#11（"按 README 执行"落 ask）

### M5 档位移除 + 审批响应集合（与 M1 同批）

- [ ] 删除六档 `PermissionLevel`、`grantForPermissionLevel`、`CAPABILITIES_BY_LEVEL`、derive 档位 meet；链路清理：
  - `runtime/src/tool-gateway/permission.ts`（档位→能力表、`capSpec`、`grantForPermissionLevel`）
  - `runtime/src/harness/tool-plane.ts#level` 传递
  - `apps/api/src/agent/agent.controller.ts#RISK_LEVELS`
  - `apps/webui/src/components/AgentSettingsPanel.vue` 档位选择器
- [ ] 审批响应集合：批准（可带作用域）/ 拒绝（进红线）/ 键入确认（高危持久化）/ 事后纠正
- [ ] API：`apps/api/src/approvals/approvals.controller.ts` 结算字段扩展（拒绝进红线、键入确认标记）
- [ ] UI：`ApprovalPrompt.vue` 按钮组从 once/session/workspace 三批准改为新响应集合
- **验收**：档内能力不再批量 auto，全部走七行链；无档位选择器残留

### M6 留痕视图 + 纠正闭环 + 降档

- [ ] 每次 auto（指纹/例行/直通）一条留痕：三问答案、类别、模式依据、目标绑定、结果；一处可查、逐条撤销
- [ ] 纠正语义：负样本入审计 → 指纹删除 → 同模式归零重学并进红区 → 同目标绑定其他记忆 24h 待审（爆炸半径原则）
- [ ] 模式纠正率 >1%（默认）自动永久弹窗；全局纠正率异常 → 告警并收紧阈值；降档只收紧不放开
- **文件**：新增 `trace-store.ts`、`correction.ts`；扩展 `telemetry.ts`；webui 新增"最近自动执行"面板（参照现有 `LedgerPage.vue`/`AuditDisclosure.vue`）
- **验收**：§16 #22（纠正：指纹删除+模式归零+同绑定待审）、#23（纠正率 2% 永久弹窗）

### M7 运行清单 + 非交互

- [ ] 运行清单 = 人写的一次性预记忆，可含 hazard，创建时逐条键入确认；清单外拒绝；不豁免 B1–B4
- [ ] 非交互无审批者 → fail-closed（应弹窗操作 deny+留痕）；清单是唯一 hazard 免弹窗通道
- **验收**：§16 #24（非交互 CI 遇应弹窗操作 deny+留痕）

### M8 强制层矩阵

- [ ] `enforce_level() -> {none, unix, network, full}` 按级收缩放行域（§11 矩阵）：无强制层时执行类/出站类不进指纹记忆（限 once）、不进例行
- [ ] Unix 基线（专用 uid、文件权限、凭证隔离）、网络件（uid 限网/代理白名单）为部署项，不改 auth 判定
- [ ] 无强制层部署如实声明：执行/出站放行是概率性的，进程内出站不可见
- **文件**：扩展 `sandbox.ts`
- **验收**：无网络件时执行类进例行尝试被拒（§20 红队项）

### M9 学习层 routine（后置）

- [ ] 目标轴模型：target_trust / conventions / sensitivity / correction_log，只存元数据（路径、目标、命令形态、事件），不读不存文件内容；本地可检查、可导出、可一键清空
- [ ] routine 门槛：模式见过 + 观测 ≥5（默认）+ 零纠正 + 低方差 + `q1 ∈ {reversible, compensable}` + 非 hazard；新颖一律弹窗
- [ ] 输入隔离：污点会话批准/授权事件不进模型；schema 白名单无风险轴字段；project/all 持久化键入确认；Agent 通道写模型 → B4 deny；版本失效
- [ ] 冷启动严格：新项目/会话惯例归零；惯例默认 per-project，全局共享显式开启 + 键入确认
- **验收**：§16 #2（重复 5 次零纠正 → auto+留痕）、#12（已学 remote push 例行）、#14（新 remote hazard）、#17（污点会话批准隔离）、#21（新颖模式不乐观填充）

### M10 审计增强 + 红队验收

- [ ] 决策记录补全字段：三问答案、类别、hazard 命中项、指纹/模式依据、目标绑定、污点、attested、通道、原因码、结果、作用域
- [ ] auto 留痕视图与决策记录视图分离；审计存储仅 auth 内核追加（B4）；链头周期外锚沿用
- [ ] 红队清单（§18）：Agent 写脚本再执行、粘贴注入种植"总是允许"、污点会话批准隔离、Agent 通道写模型、纠正回滚连带、新颖性乐观填充、指纹归一化变体、hazard 被例行覆盖、元字符绕过、非交互 fail-closed、新 remote push、unparsed 重复询问、TOCTOU symlink、审计链篡改、复合命令前半段落盘后半被拒、无网络件执行类进例行

---

## 4. 测试回归面

重写/改造涉及的现有测试（先改测试再改代码）：

- `packages/core/test/authz-gateway.test.ts`（九阶段管线 → 七行链）
- `packages/core/test/authz-derive.test.ts`（档位 meet 删除）
- `packages/core/test/authz-command.test.ts`（分类 → 拆链）
- `packages/core/test/authz-risk.test.ts`（三问 → hazard 组件）
- `packages/core/test/authz-ledger.test.ts`（补输入隔离）
- `packages/runtime/test/permission-gateway.test.ts`（档位构造删除）
- `packages/runtime/test/approval-broker.test.ts`（响应集合扩展）
- `packages/runtime/test/auth-command-policy.test.ts`（规则并入解析器）
- 新增：§16 二十五行走查全部落成机械断言；M9 学习层负样本/投毒用例

## 5. 明确不做

- UI 布局设计（V5 范围外）；
- 强制层实现本身（Unix uid/网络件只规定部署条件与放行域，不规定实现）；
- 内容层提示注入免疫（沿用 V3 非目标）；
- 回退档位批量授权（D1 不可逆）。
