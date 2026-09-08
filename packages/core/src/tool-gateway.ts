/**
 * packages/core/src/tool-gateway.ts
 *
 * ToolGateway —— 工具调用的统一出口（唯一咽喉）。
 *
 * ── 设计立场 ──────────────────────────────────────────────────────────
 * 权限三段生命：grant(根层签署) → derive(派生计算) → enforce(调用时强制)。
 * 本契约是第三段的行为接口：Capacity（planner 组装的资源包）回答"这一轮
 * 允许什么"（供给面，静态数据）；ToolGateway 回答"这一次调用是否放行、
 * 如何执行"（执行面，动态行为）。
 *
 * 隐喻对齐：模型 = 用户态，工具 = 内核资源，Gateway = syscall trap。
 * 每次 tool_call 陷入此处，harness 做检查、审批、审计、fail-closed。
 * 接口词汇与观测层事件词汇同源：invoke / result / blocked。
 *
 * ── 管道规范（实现必须遵守的语义基线）────────────────────────────────
 * invoke 内部按以下阶段顺序执行（见 GATEWAY_PIPELINE_STAGES）：
 *
 *   ① escalation-short-circuit  升权字段偏序短路（V12）：非严格更宽 →
 *                                整体忽略升权字段，按普通调用直行——
 *                                不报错、不降级、不进审批
 *   ② supply-check              工具 ∈ 注册表 + effectClass 已声明 +
 *                                args 通过 schema 校验（V5 closed-world）
 *   ③ hook-chain                pre-execute 钩子链，deny 单调不可翻转（V14）
 *   ④ tier-dispatch             联合分派：effectClass 与 coEffects 各自
 *                                查 effective；任一 forbidden → 拒绝；
 *                                全体档位取最严者 governs：
 *                                forbidden → 拒绝 / auto → ⑦ / gated → ⑤
 *   ⑤ scope-check               值层范围：各类 scope（paths/hosts/
 *                                amountLimit）分别检查，投影命中白名单
 *                                → 预授权静默放行（恒 gated 类除外，
 *                                V8 白名单不豁免）；任一未命中 → ⑥
 *   ⑥ danger-match              DangerRule 值层匹配（命令模式/SQL 谓词/
 *                                敏感路径），命中按 outcome 处置
 *   ⑦ approval                   范围外/高危 → ApprovalSeam，返回
 *                                pending(handle)；服务缺位 → fail-closed
 *                                拒绝（V13），绝不挂起
 *   ⑧ budget                    steps/tokens/cost 扣减，超限 →
 *                                BUDGET_EXHAUSTED（settle 执行时须复查）
 *   ⑨ execute                    handler 在沙盒内无特权执行（V6）；
 *                                环境由 Deployer 按 D1–D3 部署
 *   ⑩ output-taint               untrustedOutput → 返回值打标
 *   ⑪ audit                      决策事件入 audit sink（永不被 flag 阻断）
 *
 * 供给过滤（tools 白名单剔除 forbidden）是体验优化，不是安全边界——
 * 模型可幻觉调用未列出的工具，②④⑤照样拦截。
 *
 * ── 沙盒部署约定（效果面与执行环境的绑定，V6 完整形态）──────────────
 *   D1 fs.exec 沙盒约定：bash 类工具是效果面动态的工具——命令内容决定
 *      实际读什么写什么连什么。网关只判锚点（进程生成本身）；命令内容
 *      的 fs/net 面由沙盒强制：exec 沙盒 profile 派生自整个 effective
 *      的 fs/net 面（fs.read 规则 → Landlock 读范围，fs.write → 写
 *      范围，net → 无网络命名空间或仅 proxy 出口）。命令内 curl 越网、
 *      cat 越读，得到的是内核 EPERM → 翻译为策略性拒绝 → on-failure 升权。
 *   D2 net.* 部署约定：net 类 handler 的执行环境为仅 proxy 出口的网络
 *      命名空间，无直连能力；域名校验发生在连接时（解析 → pin IP →
 *      建连 → 二次解析不一致即拒，防 DNS rebinding）。
 *   D3 full-trust 部署约定：trust: 'full' 的工具（MCP server、插件等
 *      无法被沙盒约束的进程）在沙盒外执行，tier 下限强制 gated（供给
 *      过滤即钳制），凭证经 secrets 解析注入进程环境，永不出现在 args，
 *      每次调用记一等风险事件。
 *
 * ── 能力覆盖说明 ──────────────────────────────────────────────────────
 *   bash        一注册吃遍所有命令：effectClass: 'fs.exec' 锚点 +
 *               commandParam 值层匹配（⑥ 拦危险命令）+ D1 沙盒判内容。
 *               不按命令拆工具。
 *   网络接口    单效果工具（http_get → net.fetch）直接注册；多效果
 *               工具（支付 API = pay + net.send）用 coEffects 联合分派。
 *   MCP         逐工具映射注册：效果按语义映射（映射不了兜底
 *               external.<server>，恒 gated）；trust: 'full'；
 *               untrustedOutput: true 默认（server 返回文本是模型可见
 *               的外部内容，作为数据进入上下文）。
 *   skill       不是工具，是编排。注册为 ToolRegistration 是类别错误：
 *               skill handler 内部再调工具 = 第二执行点（V6 直接违反）。
 *               正确物化：SkillManifest { prompt, toolNames,
 *               policyTemplate } → spawn 子 Turn → derive → 子 Gateway
 *               实例——合法的递归是 spawn → derive → 新 Gateway，
 *               不是 handler 内嵌 Gateway。
 *
 * ── 不变量映射 ────────────────────────────────────────────────────────
 *   V5  closed-world            ToolRegistration.effectClass 必填 + ②
 *   V6  唯一咽喉/handler 无特权  invoke 唯一入口 + ToolHandler 签名
 *   V8  恒 gated 不豁免          effectiveTier 钳制规则（实现遵守）
 *   V11 身份 harness 注入        InvocationRequest 无身份字段；bindInput
 *                                由执行循环注入
 *   V12 升权短路                 escalation 可选字段 + ① 语义
 *   V13 fail-closed              审批缺件/secrets 不可解析 → 拒绝不挂起
 *   V14 单调守卫                 GatewayHook + deny 不可翻转
 */

import type { ApprovalSeam } from './approval.js';
import type {
    AppliedDangerRule,
    Budget,
    EffectClass,
    EffectivePolicy,
    EffectRule,
    PermissionLevel,
    RejectCode,
    SideEffectScope,
} from './authorization.js';
import type { TraceIdentifiers } from './observability.js';

/** 沙箱执行配置（迁移期就地定义；后续随执行环境契约收敛） */
export interface SandboxSpec {
    enabled: boolean;
    network?: { allowInternet: boolean; allowedHosts?: string[] };
    filesystem?: { writableRoots?: string[] };
    process?: { allowSpawn: boolean };
}

/** 工具参数 JSON-Schema（开放结构；provider-core 用 ToolSchema.parameters 表达） */
export type JSONSchemaSpec = Record<string, unknown>;

// ============================================================
// §1 工具注册契约（V5 注册点）
// ============================================================

/**
 * 外部进程信任标注。
 * confined = 可被沙盒约束（handler 在 D1/D2 环境内执行）；
 * full     = 不受沙盒约束的进程（MCP server 等，D3），tier 下限
 *            强制 gated，每次调用记一等风险事件。
 */
export type ToolTrust = 'confined' | 'full';

/**
 * 秘密引用：Deployer 在部署沙盒时解析（环境变量/挂载文件注入进程
 * 环境）。永不出现在 args（模型可见面）；永不出现在 ToolSpec（供给面）。
 * 解析表属于 Deployer 配置，不属于本契约。
 * 声明了 secrets 而解析失败 → fail-closed 拒绝（V13，映射
 * SANDBOX_UNAVAILABLE——秘密注入是环境部署的一部分）。
 */
export type SecretRef = string;

/**
 * 值层投影声明：注册时声明哪些参数承载路径/域名/金额/命令/SQL，
 * 运行时由实现据此从 args 提取值做 ⑤⑥ 检查。
 */
export interface ScopeProjection {
    /** 值为文件路径的参数名列表 */
    pathParams?: string[];
    /** 值为域名/URL 的参数名列表 */
    hostParams?: string[];
    /** 值为金额的参数名（pay 类：{ currency, amount } 或 number） */
    amountParam?: string;
    /** 值为命令内容的参数名（fs.exec 类：供 ⑥ commandPatterns 匹配） */
    commandParam?: string;
    /** 值为 SQL 语句的参数名（db.* 类：供 ⑥ sqlPredicates 匹配） */
    sqlParam?: string;
}

/** 运行时从 args 提取的值投影产物（⑤⑥ 的输入） */
export interface ValueProjection {
    path?: string;
    host?: string;
    amount?: { currency: string; amount: number };
    command?: string;
    sql?: string;
}

/** 投影函数签名（实现在 executor 层） */
export type ScopeProjector = (
    args: Record<string, unknown>,
    projection: ScopeProjection,
) => ValueProjection;

/**
 * 工具执行上下文——刻意最小化。
 *
 * V6：handler 是无特权纯逻辑。此处没有 policy 访问、没有注册表、
 * 没有身份、没有任何权限判断 API——权限检查只有一个执行点（Gateway
 * 管线 ④⑤⑥），执行环境配置只有一个执行点（executor 层的 Deployer）。
 * handler 内部永远不做权限判断，也无法做出。
 */
export interface HandlerContext {
    /** 取消信号（超时 / kill switch / 预算中止） */
    signal: AbortSignal;
}

/** 工具返回值。untrusted = true 时走出口加工（⑩），作为数据进入上下文 */
export interface ToolOutput {
    value: unknown;
    untrusted?: boolean;
}

/** 工具实现本体 */
export type ToolHandler = (
    args: Record<string, unknown>,
    ctx: HandlerContext,
) => Promise<ToolOutput>;

/**
 * 注册表条目。无注册即 forbidden（V5 closed-world）。
 *
 * 切分原则：工具按效果面切分，不按能力切分。generic http(method, url,
 * body) 这种 method 决定 fetch/send 语义的工具是反模式——拆成两个
 * 注册，派单才可静态判定。
 */
export interface ToolRegistration {
    name: string;
    description: string;
    /** TypeBox 产物形状兼容（与 @mazi/provider 桥接），core 不导入 pi-ai */
    parameters: JSONSchemaSpec;

    /** 派单锚点：tier 分派（④）、审计主类、升权判定的主 effectClass */
    effectClass: EffectClass;

    /**
     * 联合检查面：本次调用同时涉及的其他效果类。
     * 分派语义（④⑤）：effectClass 与全部 coEffects 须均非 forbidden，
     * 全体 tier 取最严者 governs，各类 scope（paths/hosts/amountLimit）
     * 分别做值层检查——任一未命中即走 ⑥ 审批。
     * 适用：进程内多效果工具（支付 API = pay + net.send）。
     * 不适用：bash 类效果面动态工具——其 fs/net 面由沙盒运行时强制
     * （D1），不进 coEffects。
     */
    coEffects?: readonly EffectClass[];

    /** 值层检查的参数投影声明 */
    scope: ScopeProjection;

    /** net.fetch / MCP 类工具置 true：返回值统一打 untrusted 标（⑩） */
    untrustedOutput?: boolean;

    trust: ToolTrust;

    /** 不可逆标记（delete/db.schema/pay/publish 语义对齐，触发更严审批回显） */
    irreversible?: boolean;

    /** 幂等声明，供重试决策 */
    idempotent?: boolean;

    /** 工具级超时（ms），并入 HandlerContext.signal */
    timeoutMs?: number;

    sideEffects: SideEffectScope[];
    minPermission: PermissionLevel;

    /** 秘密引用（见 SecretRef 契约与 D3 约定） */
    secrets?: readonly SecretRef[];

    handler: ToolHandler;
}

// ============================================================
// §2 供给视图
// ============================================================

/**
 * Gateway 暴露给模型的工具视图——供给过滤后的白名单。
 * forbidden 的工具不出现在此列表；但 invoke 的 ②④⑤ 仍拦截一切
 * 幻觉/伪造调用（白名单是视野收缩，不是安全边界）。
 */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    effectClass: EffectClass;
    /**
     * 供给过滤后的生效档位：forbidden 已被剔除；此处为 effectClass 与
     * coEffects 联合分派后的最严档（恒 gated 类与 trust: 'full' 钳制
     * 为 gated，V8）。
     */
    effectiveTier: 'auto' | 'gated';
    trust: ToolTrust;
    irreversible?: boolean;
    sideEffects: SideEffectScope[];
    minPermission: PermissionLevel;
    /** 值层白名单（主 effectClass 的投影；值层检查实现按类全量判） */
    scope?: { paths?: string[]; hosts?: string[] };
}

// ============================================================
// §3 调用契约
// ============================================================

/**
 * 升权载荷。V12 语义：仅当 requested 相对 effective 严格更宽
 * （档位更高，或同档且范围严格扩大）时才进入 justification 校验
 * 与审批链；否则实现必须整体忽略本字段，按普通调用直行——
 * 不报错、不降级、不进审批、不校验 justification。偏序判定函数
 * 在 executor 实现，语义期望矩阵见 core/src/semantics.ts。
 */
export interface EscalationPayload {
    requested: EffectRule;
    /** 一句话理由。仅严格更宽时校验非空 */
    justification: string;
}

/**
 * 调用请求。
 *
 * V11：本结构无任何身份字段（无 contractId/turnId/sessionId）。
 * 身份在 Gateway 构造时由 harness 经 GatewayBindInput 注入——
 * 模型无法选择身份，权限提升在类型结构上不可表达。
 */
export interface InvocationRequest {
    /** 要调用的工具名（须已在注册表） */
    tool: string;
    /** 参数（② 阶段做 schema 校验，不合规则拒绝） */
    args: Record<string, unknown>;
    /** 升权请求（可选，走 ① 偏序短路） */
    escalation?: EscalationPayload;
}

/** pending 审批句柄 */
export type PendingHandle = string;

/** 审批结算（由审批门经 settle 注入，不经模型） */
export type PendingSettlement =
    | { decision: 'granted' } // allowed-once：按原请求执行一次
    | { decision: 'rejected'; reason: string }
    | { decision: 'cancelled' };

/**
 * 调用三态。
 *
 * 拒绝必须结构化且可行动——裸 permission denied 是 agent 重试
 * 死循环的头号来源（dsh 实证）。hint 给出范围内的更窄替代或
 * "勿重试同类"指引。
 */
export type InvocationResult =
    | { kind: 'executed'; value: unknown; untrusted?: boolean }
    | { kind: 'pending'; handle: PendingHandle; effectClass: EffectClass; hint: string }
    | { kind: 'rejected'; code: RejectCode; hint: string; dangerRuleId?: string };

// ============================================================
// §4 钩子契约（V14 单调守卫）
// ============================================================

export interface HookContext {
    tool: ToolSpec;
    args: Record<string, unknown>;
    projection: ValueProjection;
    identifiers: TraceIdentifiers;
}

export type HookVerdict =
    | { verdict: 'allow' }
    | { verdict: 'deny'; code: RejectCode; hint: string };

/**
 * 管道 pre/post 钩子。
 *
 * V14 单调性（实现必须保证）：一次 invoke 内，一旦任何钩子返回
 * deny，后续钩子即使返回 allow 也无法翻转本次调用的结局——
 * deny 是本次调用内的吸收态。
 */
export interface GatewayHook {
    id: string;
    preExecute(ctx: HookContext): HookVerdict | Promise<HookVerdict>;
    /** 只读事后钩子：不可修改结果，仅供观测/审计 */
    postExecute?(ctx: HookContext & { result: ToolOutput }): void | Promise<void>;
}

// ============================================================
// §5 审计契约（decisionLog 的接口化）
// ============================================================

/** 管道阶段规范常量——实现的阶段名与此对齐，审计事件才可横向比较 */
export const GATEWAY_PIPELINE_STAGES = [
    'escalation-short-circuit',
    'supply-check',
    'hook-chain',
    'tier-dispatch',
    'scope-check',
    'danger-match',
    'approval',
    'budget',
    'execute',
    'output-taint',
    'audit',
] as const;

export type GatewayStage = (typeof GATEWAY_PIPELINE_STAGES)[number];

export interface GatewayAuditEvent {
    stage: GatewayStage;
    /** allowed=放行 denied=拒绝 pending=入队 info=记账 */
    decision: 'allowed' | 'denied' | 'pending' | 'info';
    /** 三层 ID 必备（v2 观测对齐），缺一即实现缺陷 */
    identifiers: TraceIdentifiers;
    tool?: string;
    effectClass?: EffectClass;
    detail?: string;
    dangerRuleId?: string;
    escalation?: EscalationPayload;
}

/**
 * 决策事件出口。
 *
 * emit 永不被 Feature Flag 阻断（v2 原则 4：flag 只控制 sink 是否
 * 消费）。被拦截的尝试也必须留痕——"agent 想做什么但被挡了"是
 * 安全分析的一等信号。
 */
export interface GatewayAuditSink {
    log(event: GatewayAuditEvent): void;
}

// ============================================================
// §6 核心接口
// ============================================================

/**
 * ToolGateway —— 每实例绑定一个 Turn。
 *
 * 有状态组件：持有该 Turn 的 effective、DangerRule、预算计数器。
 * Turn 结束即弃，计数器不跨 Turn。
 */
export interface ToolGateway {
    /** 绑定的 Turn（身份已注入，模型不可伪造） */
    readonly turnId: string;
    /** 供给过滤后的工具白名单（视野收缩，非安全边界） */
    readonly tools: readonly ToolSpec[];

    /**
     * 唯一调用出口。管道阶段顺序见文件头规范与
     * GATEWAY_PIPELINE_STAGES。并发调用的预算计数必须原子（实现保证）。
     */
    invoke(req: InvocationRequest): Promise<InvocationResult>;

    /**
     * pull：模型主动查询 pending 状态。
     * 返回 undefined = handle 未知；未结算返回 pending 副本；
     * 已结算返回最终结果。（push 注入由 executor 执行循环在下一轮
     * 开始时完成，两者并存、push 为主。）
     */
    checkPending(handle: PendingHandle): Promise<InvocationResult | undefined>;

    /**
     * push 注入审批结果（由审批门/executor 调用，不经模型）。
     * granted 时按原请求执行一次——allowed-once 语义：批准只适用
     * 本次动作，绝不回写 grant（权限持久变化只走 ContractRevision）。
     * 执行前须复查预算（⑧）与钩子仍有效；handle 未知或已结算返回
     * undefined。
     */
    settle(
        handle: PendingHandle,
        settlement: PendingSettlement,
    ): Promise<InvocationResult | undefined>;
}

/**
 * 工厂：为一个 Turn 构造绑定实例。
 * executor 持有；bindInput 的身份来自执行循环的活跃游标（V11）。
 */
export interface ToolGatewayFactory {
    forTurn(bind: GatewayBindInput): ToolGateway;
}

/**
 * 构造输入 = Capacity 交接的权限数据 + harness 注入的身份 + 周边服务。
 *
 * V2 不变量：本结构只含 effective（计算结果）与注册表引用——
 * 没有任何字段能让 Gateway 实例凭空放宽权限。
 */
export interface GatewayBindInput {
    // —— 身份（harness 注入，模型输出不含）——
    sessionId: string;
    turnId: string;

    // —— 权限数据（派生产物，Gateway 只消费不计算）——
    effective: EffectivePolicy;
    dangerRules: readonly AppliedDangerRule[];
    budget: Budget;
    toolRegistry: ReadonlyMap<string, ToolRegistration>;
    /** 沙盒配置（来自 Capacity.sandbox；Deployer 按 D1–D3 部署执行环境） */
    sandbox: SandboxSpec;

    // —— 周边服务 ——
    /** 审批 Seam（L1 policy 实现）；缺位时实现必须 fail-closed（V13） */
    approval: ApprovalSeam;
    /** 决策事件出口（emit 永不被 flag 阻断） */
    audit: GatewayAuditSink;
    /** pre-execute 钩子链（V14 单调守卫） */
    hooks?: readonly GatewayHook[];
}

// ============================================================
// §7 注册示例（文档；类型-checked 的用例见 __tests__/registrations.ts）
// ============================================================

/**
 * bash —— 一注册吃遍所有命令，效果面交给沙盒（D1）：
 *
 *   {
 *     name: 'bash', effectClass: 'fs.exec',
 *     parameters: { type: 'object',
 *       properties: { command: { type: 'string' } },
 *       required: ['command'] },
 *     scope: { commandParam: 'command' },
 *     trust: 'confined', sideEffects: ['process', 'fs', 'net'],
 *     handler: spawnInSandbox,
 *   }
 *
 * HTTP GET —— 单效果，hosts 白名单 + proxy（D2）：
 *
 *   {
 *     name: 'http_get', effectClass: 'net.fetch',
 *     parameters: { type: 'object',
 *       properties: { url: { type: 'string' } },
 *       required: ['url'] },
 *     scope: { hostParams: ['url'] },
 *     untrustedOutput: true, trust: 'confined', sideEffects: ['net'],
 *     handler: fetchViaProxy,
 *   }
 *
 * 支付 API —— 多效果联合分派 + 秘密注入：
 *
 *   {
 *     name: 'charge', effectClass: 'pay', coEffects: ['net.send'],
 *     parameters: { type: 'object',
 *       properties: { amount: { type: 'number' },
 *                     currency: { type: 'string' } },
 *       required: ['amount', 'currency'] },
 *     scope: { amountParam: 'amount', hostParams: ['endpoint'] },
 *     secrets: ['secret:merchant-key'],
 *     irreversible: true, trust: 'confined', sideEffects: ['pay', 'net'],
 *     handler: callMerchantApi,
 *   }
 *
 * MCP 工具 —— 逐个映射，全信标注（D3）：
 *
 *   {
 *     name: 'mcp.github.create_issue', effectClass: 'publish',
 *     parameters: mcpToolSchema,
 *     trust: 'full', untrustedOutput: true,
 *     secrets: ['secret:github-token'], sideEffects: ['external-api'],
 *     handler: callMcpServer,
 *   }
 */
