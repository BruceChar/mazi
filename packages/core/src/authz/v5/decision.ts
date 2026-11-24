/**
 * V5 决策内核（§1 七行链、§5 hazard、§6 底线 B1–B4）。
 *
 * 纯函数：输入结构化 Op，输出 auto | ask | deny。机械规则永远成立；
 * blocked / memory / routine / passthrough 由上下文注入，学习层对风险轴无写权限。
 * 本模块不解析命令、不分类目标——那是 parser/classifier 的职责（M2）。
 */

// ============================================================
// 结构化 Op（§4）
// ============================================================

/** Q1 后果：可撤回吗？答不出 → unproven，按 irreversible 对待。 */
export type Q1 = 'reversible' | 'compensable' | 'irreversible' | 'unproven';

/** Q2 认知：带什么进出上下文。secret 由 B1 直接拦，不靠污点。 */
export type DataClass = 'clean' | 'tainted' | 'secret';

/** 对象类别（§4 表）。 */
export type ObjectClass =
    | 'build_artifact'
    | 'source'
    | 'source_dirty'
    | 'sensitive'
    | 'external'
    | 'critical'
    | 'unknown';

export type OpAction = 'read' | 'write' | 'delete' | 'exec' | 'egress';

/** 通道：真人 UI / Agent / 非交互。 */
export type Channel = 'ui_user' | 'agent' | 'non_interactive';

/** 直通锚定：逐字 / 派生 / 无锚定。 */
export type Attestation = 'verbatim' | 'derived' | 'none';

export interface Op {
    action: OpAction;
    /** 目标：路径 / host / remote / 收件人。 */
    target: string;
    object: ObjectClass;
    data: DataClass;
    q1: Q1;
    /** Q3：写入改变将来自动执行的能力边界（envelope），非内容修改。 */
    envelope: boolean;
    /** 来源链：本会话写入 / 网络下载 / 新装依赖。 */
    originChain: boolean;
    /** 目标链：目标不在会话基线（未知目标默认 true）。 */
    targetFresh: boolean;
    channel: Channel;
    attested: Attestation;
    /** 拆解失败 / 未知语法。 */
    unparsed: boolean;
}

// ============================================================
// §6 底线 B1–B4（不可学习、不可覆盖）
// ============================================================

export type BottomVerdict = 'deny' | 'ask' | null;

const SYSTEM_ROOT_PATTERNS = [
    /^\/$/,
    /^~$/,
    /^\/etc(\/|$)/,
    /^\/usr(\/|$)/,
    /^\/bin(\/|$)/,
    /^\/System(\/|$)/,
];

function isSystemRoot(target: string): boolean {
    const t = target.trim();
    return SYSTEM_ROOT_PATTERNS.some((p) => p.test(t));
}

const DESTRUCTIVE_EXEC = /\bmkfs\b|\bfdisk\b|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

/**
 * 底线求值。返回 'deny' / 'ask' / null（未命中底线）。
 * B3 污点出站是 ask（永不学习、永不记忆、永不例行），不是 deny。
 */
export function bottom(op: Op): BottomVerdict {
    // B1 秘密断流：未解锁秘密不进上下文；携秘密出站/落盘拒绝。
    if (
        op.data === 'secret' &&
        (op.action === 'read' || op.action === 'egress' || op.action === 'write')
    ) {
        return 'deny';
    }
    // B2 系统毁灭：系统路径删、mkfs、fork bomb。
    if (op.action === 'delete' && isSystemRoot(op.target)) return 'deny';
    if (op.action === 'exec' && DESTRUCTIVE_EXEC.test(op.target)) return 'deny';
    // B3 污点出站：tainted 且 egress 到 external → ask，永不学习。
    if (op.data === 'tainted' && op.action === 'egress' && op.object === 'external') return 'ask';
    // B4 元操作与信任根：Agent 通道写策略/学习模型/阈值/审计 → deny。
    if (op.channel === 'agent' && op.action === 'write' && op.object === 'critical') return 'deny';
    return null;
}

// ============================================================
// §5 hazard 机械高危（学习不可达）
// ============================================================

/** hazard：永远弹窗至少一次；放行仅指纹记忆（作用域受限）或当次点名两通道。 */
export function isHazard(op: Op): boolean {
    return (
        op.q1 === 'irreversible' ||
        op.q1 === 'unproven' ||
        op.object === 'critical' ||
        (op.object === 'external' &&
            (op.action === 'read' ||
                op.action === 'write' ||
                op.action === 'delete' ||
                op.action === 'exec')) ||
        op.envelope ||
        (op.originChain && op.action === 'exec') ||
        (op.action === 'egress' && op.targetFresh) ||
        op.unparsed
    );
}

// ============================================================
// §1 七行决策链
// ============================================================

export type Decision = 'auto' | 'ask' | 'deny';

/** 各放行通道由调用方注入；学习层只提供 routineHit，不触碰风险轴。 */
export interface DecisionContext {
    /** blocked：用户显式否决红线，点名也问一次。 */
    isBlocked: (op: Op) => boolean;
    /** memory：完全相同指纹 + 目标绑定 + 内容哈希的重复。 */
    memoryHit: (op: Op) => boolean;
    /** routine：已验证的例行惯例（M9）。 */
    routineHit: (op: Op) => boolean;
    /** passthrough：逐字点名 + 真人通道 + round_clean + 非 hazard，当次有效。 */
    passthrough: (op: Op) => boolean;
}

/**
 * decide 七行，顺序即优先级：
 * bottom → blocked → hazard → passthrough → memory → routine → default ask。
 */
export function decide(op: Op, ctx: DecisionContext): Decision {
    const verdict = bottom(op);
    if (verdict === 'deny') return 'deny';
    if (verdict === 'ask') return 'ask';
    if (ctx.isBlocked(op)) return 'ask';
    if (isHazard(op)) return 'ask';
    // §4 读默认规则：工作区内普通路径 read → auto_log（不弹窗，留痕）。
    // external 读已被 hazard 捕获；sensitive 读同样 auto_log + 打污点。
    if (op.action === 'read') return 'auto';
    if (ctx.passthrough(op)) return 'auto';
    if (ctx.memoryHit(op)) return 'auto';
    if (ctx.routineHit(op)) return 'auto';
    return 'ask';
}
