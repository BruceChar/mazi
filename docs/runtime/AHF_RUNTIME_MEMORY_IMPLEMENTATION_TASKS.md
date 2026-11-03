# AHF Runtime 长期记忆与用户画像实施待办

> 版本：v1.0  
> 状态：待排期  
> 日期：2026-11-04  
> 设计依据：`docs/runtime/AHF_RUNTIME_MEMORY_SYSTEM_DESIGN.md`

## 1. 使用规则

- 本清单只描述实现待办，不表示功能已经完成。
- 每项实现前必须补充或更新对应文档；接口、状态和验收发生变化时同步修订设计稿。
- 每项先补测试，再实现生产代码。
- 每项完成必须满足该项“验收”和所属阶段门禁。
- 记忆、人格、隐私和租户隔离不得通过“先上线后补安全”推进。
- 当前仓库存在其他并行改动；每项应独立提交，不夹带无关修改。

## 2. P0 阻断项

这些项目未完成前，不进入自动抽取和人格画像生产化。

### [ ] MEM-P0-01 统一可信身份与租户作用域

**目标**：Memory、Persona 和 Behavior 使用服务端可信身份，不接受客户端任意指定记录所有权。

**交付**：

- 定义 `tenantId/userId/workspaceId/projectId/conversationId/rootGoalId` 作用域。
- 本地部署显式生成稳定 local tenant/user。
- API 从认证或本地会话上下文取得身份。
- 读、写、纠正、删除和导出均验证所有权。

**验收**：

- 客户端无法通过修改 userId 读取其他用户记忆。
- 本地部署和未来多租户使用同一查询契约。
- 跨用户读、改、删、导出均有拒绝测试。

**依赖**：无。

### [ ] MEM-P0-02 修复 unionScope 隔离语义

**目标**：作用域并集只在同一 tenant/user 内展开。

**交付**：

- 改为一个带硬约束的复合查询，或先构造严格 scoped id 集合再求并集。
- project/workspace/conversation 查询默认附带 tenant/user 约束。
- 增加显式 global scope，禁止用缺失字段代表“全库”。

**验收**：

- `{userId:u1, projectId:p1, unionScope:true}` 不返回 u2 的 project 记录。
- 同名、共享项目、共享工作区和同会话恶意请求均有回归测试。
- `crossProjectLeakCount = 0`。

**依赖**：MEM-P0-01。

### [ ] MEM-P0-03 候选记忆默认不可召回

**目标**：模型推断和待确认内容不能进入 Agent 上下文。

**交付**：

- 新增 candidate 状态或等效状态机。
- 默认 recall 只返回 active + confirmed。
- 明确支持“当前会话内可见候选”时增加显式开关，不改变默认行为。

**验收**：

- `pending_confirmation` 不出现在普通 recall、ContextContribution 和 Agent 上下文。
- 用户确认后才可跨会话召回。
- 候选泄漏测试和 API 回归通过。

**依赖**：无。

### [ ] MEM-P0-04 启用运行时 token 预算

**目标**：MemoryManager 在真实 Harness 中受固定预算约束。

**交付**：

- 为常驻事实、动态任务记忆和人格指导配置独立预算。
- 打包时记录选中项、丢弃项和估算 token。
- 超出预算时按显式优先级裁剪，不注入超长单条原文。
- 预算上限可配置，但存在不可突破的硬上限。

**验收**：

- 任何运行均不因记忆注入突破配置预算。
- 预算为 0 时禁止记忆注入。
- 审计能解释为什么选中或丢弃。

**依赖**：MEM-P0-03。

### [ ] MEM-P0-05 建立 P0 安全回归集

**目标**：将当前高风险问题固化为 CI 测试。

**交付**：

- 跨用户泄漏；
- 跨项目泄漏；
- candidate 注入；
- token 超限；
- 删除后再次召回；
- 设备本地 local identity 场景。

**验收**：

- 所有用例自动运行。
- 任一安全门禁失败会阻断合并。

**依赖**：MEM-P0-01 至 MEM-P0-04。

## 3. P1 异步可靠底座

### [ ] MEM-P1-01 新增 Capture Outbox

**目标**：记忆抽取请求持久化、可恢复、可重试。

**交付**：

- 新增 `memory_jobs` 表；
- 定义 job kind、scope、sourceRef、status、attempts、lease 和错误字段；
- 源事实与 capture job 在同一事务落库；
- 唯一键保证幂等。

**验收**：

- 进程崩溃后 pending job 仍存在。
- 同一来源重复入队不产生重复有效结果。
- LLM 调用不位于数据库事务内。

**依赖**：MEM-P0-01、MEM-P0-02。

### [ ] MEM-P1-02 实现可恢复 Memory Worker

**目标**：后台领取并执行记忆任务。

**交付**：

- 租约领取；
- 最大并发；
- 指数退避；
- dead-letter 状态；
- 优雅停机；
- 每租户 token/成本上限。

**验收**：

- 两个 Worker 不重复处理同一租约。
- 失败任务按策略重试。
- 重启后可继续未完成任务。
- Worker 失败不影响主对话成功。

**依赖**：MEM-P1-01。

### [ ] MEM-P1-03 任务观测与审计

**目标**：能够解释每个后台记忆任务的输入、输出和成本。

**交付**：

- 记录 jobId、sourceRef、模型、prompt 版本、extractor 版本；
- 记录耗时、token、输出数量、去重数、拒绝原因；
- 发出 `memory.extraction.started/completed/failed` 运行事件；
- 提供管理查询接口或诊断视图。

**验收**：

- 任一记忆项能追溯到产生它的 job 与证据。
- 失败原因可用于定位模型、schema 或来源问题。

**依赖**：MEM-P1-01、MEM-P1-02。

### [ ] MEM-P1-04 来源快照与删除传播

**目标**：抽取可复现，原始来源删除后派生内容可失效。

**交付**：

- capture job 保存 source snapshot hash 或不可变切片引用；
- 删除原始行为/反馈时取消 pending job；
- 标记相关 memory/observation 失效；
- 触发画像重算和索引删除；
- tombstone 阻止重新学习相同内容。

**验收**：

- 相同 source + version + extractor 可得到相同测试结果。
- 删除原始证据后画像不再引用。
- tombstone 内容不会从摘要或残留索引重新召回。

**依赖**：MEM-P1-01、MEM-P1-03。

## 4. P1 自动抽取

### [ ] MEM-P1-05 定义 InteractionExtractor 接口

**目标**：将抽取能力与具体模型解耦。

**交付**：

- `InteractionExtractor.extract(input): Promise<ExtractionResult>`；
- `ExtractionResult { memories, personaObservations }`；
- 支持 deterministic fake、recorded response 和真实 provider；
- 所有输入带 extractorVersion 和 promptVersion。

**验收**：

- 单元测试不依赖网络。
- 抽取器不能访问写库 API。
- 输入输出 schema 可校验。

**依赖**：MEM-P1-01。

### [ ] MEM-P1-06 实现确定性预过滤

**目标**：在 LLM 前降低噪声、成本和泄漏风险。

**交付**：

- 重复事件过滤；
- secret 与敏感信息检测；
- 工具日志截断/引用策略；
- 空输入和纯控制事件处理；
- 闲聊/负反馈仍保留人格抽取入口。

**验收**：

- 重复工具轮询不重复调用模型。
- secret 不进入抽取 prompt。
- 感谢、生气和批评不会被预过滤错误丢弃。

**依赖**：MEM-P1-05。

### [ ] MEM-P1-07 定义严格抽取 JSON Schema

**目标**：模型输出可直接校验，不能自由文本写库。

**交付**：

- memories schema；
- personaObservations schema；
- evidenceRef 格式；
- confidence/importance/strength 范围；
- 空结果格式；
- prompt 注入防护和“证据不足则不输出”规则。

**验收**：

- 非法类型、越界分数、虚构来源和模型自定 scope 均被拒绝。
- 安全输入和恶意 prompt 有回归样本。

**依赖**：MEM-P1-05。

### [ ] MEM-P1-08 实现 MemoryWriter

**目标**：由 Runtime 根据抽取结果可靠落库。

**交付**：

- 注入可信 scope；
- 校验 evidence；
- 生成 contentHash；
- 执行 ADD-only；
- 候选/正式状态判定；
- 去重；
- 写入 evidence relation；
- 生成 embedding/index pending 任务。

**验收**：

- 同一输出重复写入幂等。
- 抽取模型不能指定其他用户或项目。
- 没有真实证据的模型推断不能成为 active。

**依赖**：MEM-P1-05、MEM-P1-07。

### [ ] MEM-P1-09 替换同步 raw memory 写入

**目标**：Task/Run 后不再同步把所有轮次和工具事实直接当长期记忆。

**交付**：

- Goal/Task/Step 继续作为执行事实；
- Task 完成时持久化 capture job；
- Run 完成时入队聚合任务；
- 显式用户记忆保留快速同步路径；
- 保留回滚和兼容开关。

**验收**：

- 记忆抽取延迟不增加用户最终回答等待时间。
- 原执行结果不因抽取失败而改变。
- 旧数据迁移和开关关闭路径有测试。

**依赖**：MEM-P1-01、MEM-P1-02、MEM-P1-08。

### [ ] MEM-P1-10 自动抽取黄金集

**目标**：用可重复数据验证“记什么”。

**交付**：

- 明确偏好；
- 项目决策；
- 用户纠正；
- 工具验证事实；
- 闲聊；
- 感谢；
- 生气；
- 批评；
- 重复；
- 敏感信息；
- 否定、计数和多跳输入。

**验收**：

- 每个样本有期望 memories 和 personaObservations。
- 报告 extraction precision/recall/duplicate/leak。

**依赖**：MEM-P1-08。

## 5. P1 用户人格画像

### [ ] MEM-P1-11 新增 PersonaObservation 存储

**目标**：保存场景化、可衰减的人格证据。

**交付**：

- observation 表；
- scope、dimension、trigger、context、polarity、strength、confidence、stability；
- sourceRefs；
- expiresAt 和状态；
- 按 tenant/user/dimension/time 的查询索引。

**验收**：

- 单次观察不会直接成为稳定画像。
- 每条观察可追溯来源。
- 跨用户隔离测试通过。

**依赖**：MEM-P0-02、MEM-P1-04。

### [ ] MEM-P1-12 新增 PersonaTrait 聚合存储

**目标**：保存可版本化、可纠正的稳定画像。

**交付**：

- trait 表；
- value、confidence、evidenceCount、distinctContexts；
- supporting/contradicting evidence；
- halfLife、status、version；
- aggregatorVersion。

**验收**：

- 同输入证据和同版本聚合器产生相同结果。
- 用户纠正后旧画像 superseded。

**依赖**：MEM-P1-11。

### [ ] MEM-P1-13 扩展 Extractor 输出人格信号

**目标**：感谢、闲聊、生气和批评进入画像证据层。

**交付**：

- 支持 communication、epistemic、decision、feedback、values、interest 维度；
- 输出 trigger/context/polarity/strength/stability；
- 单次反应默认 transient；
- 明确陈述标记 explicit。

**验收**：

- 闲聊不会默认生成事实记忆。
- 生气和批评不会因“无任务价值”被丢弃。
- 单次愤怒不会直接产生稳定人格标签。

**依赖**：MEM-P1-07、MEM-P1-11。

### [ ] MEM-P1-14 实现 PersonaAggregator

**目标**：从证据累积生成画像。

**交付**：

- 时间衰减；
- 来源可信度；
- 正负证据；
- distinct context；
- 最低证据数；
- confidence 门槛；
- 用户明确优先级。

**验收**：

- 3 条同类独立证据满足条件后才进入 established。
- 相反证据会降低置信度。
- 超时证据自然衰减。
- 删除证据后画像重算。

**依赖**：MEM-P1-12、MEM-P1-13。

### [ ] MEM-P1-15 人格画像注入

**目标**：将稳定画像转化为有界交互指导。

**交付**：

- 独立 persona contribution；
- 只注入 established 或 explicit 结论；
- 注入证据概览、置信度和时间，不注入原始情绪文本；
- 明确“画像不是绝对事实”；
- 限制 250 tokens。

**验收**：

- transient 画像不跨会话注入。
- Agent 不会在回答中主动泄漏画像。
- 注入关闭后不影响系统运行。

**依赖**：MEM-P0-04、MEM-P1-14。

### [ ] MEM-P1-16 人格治理 API/UI

**目标**：用户可查看、确认、纠正、删除和关闭画像学习。

**交付**：

- 查看维度、结论、置信度和证据；
- 纠正画像；
- 删除单条证据；
- 删除整个维度；
- 暂停/恢复学习；
- 导出/重建。

**验收**：

- 删除传播到画像和索引。
- 用户能区分事实记忆和人格推断。
- 客户端无法访问其他用户画像。

**依赖**：MEM-P1-11 至 MEM-P1-15。

### [ ] MEM-P1-17 人格画像评测

**目标**：防止误升级、过拟合和敏感推断。

**交付**：

- 单次生气不升级；
- 重复负反馈升级；
- 明确偏好覆盖；
- 正负证据并存；
- 删除后重建；
- 跨用户零泄漏；
- 敏感属性拒绝推断。

**验收**：

- 指标可离线重复运行。
- CI 有固定 faux extractor。
- 报告含过度推断和敏感推断计数。

**依赖**：MEM-P1-14。

## 6. P2 检索与冲突

### [ ] MEM-P2-01 引入可组合检索接口

**目标**：从单关键词评分升级为可替换召回器。

**交付**：

- LexicalRetriever；
- VectorRetriever；
- MetadataRetriever；
- Fusion/Rerank seam；
- deterministic fake。

**验收**：

- 任一召回器关闭时系统可降级。
- 硬作用域过滤在融合前执行。

**依赖**：MEM-P0-02、MEM-P0-04。

### [ ] MEM-P2-02 实现 FTS/BM25

**目标**：改善专有名词、代码标识符和精确事实召回。

**交付**：

- SQLite FTS 表或等效索引；
- 增量 upsert/delete；
- 中文 token 策略；
- 关键字高亮或得分诊断。

**验收**：

- 与当前纯词法评分基线对比。
- 删除和 tombstone 立即从索引移除。

**依赖**：MEM-P2-01。

### [ ] MEM-P2-03 实现 embedding 适配器

**目标**：支持语义召回且保持供应商中立。

**交付**：

- EmbeddingProvider 接口；
- embedding 缓存；
- pending/ready/failed 索引状态；
- 批量重试；
- 维度与模型版本存储。

**验收**：

- embedding 失败不回滚记忆事实。
- 重建索引可幂等执行。
- 相同 contentHash 不重复付费。

**依赖**：MEM-P2-01。

### [ ] MEM-P2-04 RRF 融合与 rerank

**目标**：组合词法、向量、实体和时间信号。

**交付**：

- RRF；
- optional reranker；
- metadata/time/importance 调制；
- top-K 诊断；
- 失败回落。

**验收**：

- 与纯向量、纯 BM25、当前策略对比报告。
- 计数、否定、多跳和精确标识符样本不退化。

**依赖**：MEM-P2-02、MEM-P2-03。

### [ ] MEM-P2-05 自动冲突消解

**目标**：同一实体/属性不注入互相矛盾的有效事实。

**交付**：

- entityKey + attribute；
- validFrom/validTo；
- supersedes/supersededBy；
- trust/confidence 比较；
- unresolved conflict 状态；
- 时间查询接口。

**验收**：

- 旧 MySQL 与新 PostgreSQL 只注入当前有效值。
- “过去是什么/现在是什么”可查询。
- 高低置信度冲突不会自动错选。

**依赖**：MEM-P1-08。

### [ ] MEM-P2-06 访问反馈与排序强化

**目标**：让实际被使用且有效的记忆得到强化。

**交付**：

- accessCount；
- lastAccessedAt；
- 召回后使用反馈；
- 被忽略项反馈；
- 访问驱动衰减。

**验收**：

- 相同查询下长期有效记忆排序改善。
- 只访问不验证不能无限强化。
- 用户删除后不再更新访问指标。

**依赖**：MEM-P2-04。

## 7. P2 反思与遗忘

### [ ] MEM-P2-07 实现 MemoryCurator 任务

**目标**：低频整理而非主链路同步执行。

**交付**：

- 定时/阈值触发；
- 合并重复 Episode；
- 冲突检查；
- 画像一致性检查；
- 成本与并发限制。

**验收**：

- 不影响主 Task 延迟。
- Curator 失败可重试，不删除源事实。

**依赖**：MEM-P1-02、MEM-P2-05。

### [ ] MEM-P2-08 情景记忆压缩为语义记忆

**目标**：从重复成功/失败中提炼稳定事实和决策。

**交付**：

- Episode 聚类；
- 高层结论候选；
- evidence refs；
- 人工/用户确认；
- 旧 Episode 可归档但不物理删除。

**验收**：

- 每个结论能回到多条 Episode。
- 不把模型猜测直接升级 confirmed。

**依赖**：MEM-P2-07。

### [ ] MEM-P2-09 程序性规则候选

**目标**：从经验提出可复用工作流，但不自动修改 system prompt。

**交付**：

- procedure candidate；
- 版本、适用条件和证据；
- 用户或 Verifier 确认；
- 可回滚；
- 生效范围和优先级。

**验收**：

- 未确认规则不注入。
- 规则与环境事实冲突时服从当前事实。
- 规则失效可回滚。

**依赖**：MEM-P2-08。

### [ ] MEM-P2-10 自动过期、归档与垃圾回收

**目标**：控制长期存储和召回质量。

**交付**：

- 默认 TTL 策略；
- 归档状态；
- 合并策略；
- 索引清理；
- 过期任务审计；
- 不误删明确长期偏好和审计事实。

**验收**：

- 过期项不进入默认召回。
- 存储增长有上限或可观测趋势。
- tombstone 和 legal/audit 保留规则明确。

**依赖**：MEM-P2-06。

## 8. P2 评测与回归

### [ ] MEM-EVAL-01 建立事实记忆黄金集

覆盖：

- 明确偏好；
- 事实更新；
- 临时事实；
- 旧项目召回；
- 否定；
- 计数；
- 多跳；
- 删除；
- 超预算；
- 候选。

**依赖**：MEM-P1-10。

### [ ] MEM-EVAL-02 建立人格黄金集

覆盖：

- 感谢；
- 生气；
- 批评；
- 闲聊；
- 明确偏好；
- 场景化负反馈；
- 相反证据；
- 删除与重建；
- 敏感属性拒答。

**依赖**：MEM-P1-17。

### [ ] MEM-EVAL-03 建立安全与隔离黄金集

覆盖：

- 跨 tenant；
- 跨 user；
- 跨 project；
- 共享 workspace；
- 恶意 bundle 导入；
- 客户端伪造 userId；
- worker 跨租户任务读取。

**依赖**：MEM-P0-05。

### [ ] MEM-EVAL-04 生成真实指标

**目标**：让现有 EvalMemoryMetrics 不再只是接口。

**交付**：

- recallAtK；
- precision；
- staleInjected；
- crossProjectLeaks；
- candidateLeaks；
- conflictInjected；
- tokenCost；
- extractionFailure；
- persona误升级。

**验收**：

- 每次评测报告包含真实值或明确 no-sample。
- 指标能按模型、extractor、prompt 和 dataset version 分组。

**依赖**：MEM-EVAL-01 至 MEM-EVAL-03。

### [ ] MEM-EVAL-05 外部基准回归

**目标**：在自定义安全与人格门禁稳定后评估外部基准。

**交付**：

- LoCoMo adapter；
- LongMemEval adapter；
- DMR adapter；
- 版本固定；
- 可重复运行脚本；
- 与自定义黄金集并行报告。

**验收**：

- 外部基准不掩盖隔离、隐私和人格误升级问题。
- 数据集与 prompt 版本可追溯。

**依赖**：MEM-P2-04、MEM-EVAL-04。

## 9. 完成定义

一个记忆或画像功能项只有同时满足以下条件才算完成：

- [ ] 设计文档已更新并与实现一致。
- [ ] 测试先于生产实现或与实现同一提交。
- [ ] 单元测试覆盖正常、边界和失败路径。
- [ ] 集成测试覆盖真实 Runtime 接线。
- [ ] 安全测试覆盖租户、用户和项目边界。
- [ ] 无 LLM 网络依赖的 deterministic 回归可运行。
- [ ] 观测记录包含来源、版本、耗时和失败原因。
- [ ] 删除与失效路径已验证。
- [ ] UI/API 行为与后端状态一致。
- [ ] 变更独立提交，提交信息引用本清单 ID。

## 10. 里程碑门禁

### M0：安全底座

- MEM-P0-01 至 MEM-P0-05 全部完成。
- 零跨用户、零 candidate 注入、预算可执行。

### M1：可靠异步与基础抽取

- MEM-P1-01 至 MEM-P1-10 全部完成。
- 会话不被抽取阻塞，Worker 可恢复，重复抽取幂等。

### M2：人格画像

- MEM-P1-11 至 MEM-P1-17 全部完成。
- 感谢、闲聊、生气和批评可产生证据。
- 单次情绪不升级稳定画像，用户可以治理。

### M3：混合检索与冲突

- MEM-P2-01 至 MEM-P2-06 全部完成。
- 词法/向量融合有对比报告，时态和冲突查询可用。

### M4：反思、遗忘与外部评测

- MEM-P2-07 至 MEM-P2-10、MEM-EVAL-01 至 MEM-EVAL-05 全部完成。
- 记忆质量、成本、隐私和长期演化均可观测、可回归。

## 11. 明确不做

- [ ] 不把全部对话原文直接写入长期向量库。
- [ ] 不让交互 Agent 无限制自主新增、覆盖、删除记忆。
- [ ] 不把单次愤怒、感谢或批评直接固化为稳定人格。
- [ ] 不用项目或工作区查询绕过 tenant/user 隔离。
- [ ] 不让候选记忆默认进入模型上下文。
- [ ] 不让 LLM 自己决定数据库归属和权限。
- [ ] 不自动上线程序性规则或改写 system prompt。
- [ ] 不在缺少证据时生成高置信度画像。
