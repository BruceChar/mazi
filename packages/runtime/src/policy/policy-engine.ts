import type {
    Capacity,
    Constraint,
    PolicyEngine,
    PolicyVerdict,
    SideEffectScope,
    ToolSpec,
} from '@mazi/core';
import { validateSchema } from './schema-validator.js';

/** 策略拒绝原因编码（reason 格式：'<code>: <detail>'） */
export type PolicyDenyCode =
    | 'tool-not-whitelisted'
    | 'permission-denied'
    | 'schema-violation'
    | 'irreversible-blocked'
    | 'constraint-denied'
    | 'budget-exceeded';

/** 权限级别升序排名（capacity.permission >= tool.minPermission 才放行） */
const PERMISSION_RANK: Record<string, number> = {
    text: 0,
    'read-only': 1,
    draft: 2,
    approved: 3,
    autonomous: 4,
};

function permissionRank(level: string): number | undefined {
    return Object.hasOwn(PERMISSION_RANK, level) ? PERMISSION_RANK[level] : undefined;
}

/** 副作用域全集（forbidden-resource rule 的合法 token 集合） */
const KNOWN_SCOPES: ReadonlySet<string> = new Set<SideEffectScope>([
    'fs',
    'net',
    'process',
    'external-api',
]);

/**
 * MVP Policy Engine 实现（MVP 文档 §5.3 校验顺序，命中即拒）：
 * 1 白名单 → 2 权限 → 3 参数 schema → 4 不可逆 → 5 goal.constraints → 6 预算。
 * 只返回 PolicyVerdict，事件由调用方（executor）emit；不含审批门。
 */
export class PolicyEngineImpl implements PolicyEngine {
    private readonly goalConstraints: Constraint[];
    private accumulatedCostUsd: number;

    constructor(opts: { goalConstraints?: Constraint[]; accumulatedCostUsd?: number } = {}) {
        this.goalConstraints = [...(opts.goalConstraints ?? [])];
        this.accumulatedCostUsd = opts.accumulatedCostUsd ?? 0;
    }

    /** 由 executor 在每次 Step 计价后回填累计成本（跨调用累计） */
    setAccumulatedCostUsd(value: number): void {
        this.accumulatedCostUsd = value;
    }

    getAccumulatedCostUsd(): number {
        return this.accumulatedCostUsd;
    }

    async checkToolCall(
        capacity: Capacity,
        toolName: string,
        args: Record<string, unknown>,
        estimatedCostUsd?: number,
    ): Promise<PolicyVerdict> {
        // 1. 白名单：toolName 必须在 capacity.tools 内
        const tool = capacity.tools.find((item) => item.name === toolName);
        if (!tool) {
            return this.deny(
                'tool-not-whitelisted',
                `工具 '${toolName}' 不在 capacity.tools 白名单内`,
            );
        }
        // 2. 权限：capacity.permission >= tool.minPermission（未知级别按 0 处理会放行，故必须显式拒绝）
        const capacityRank = permissionRank(capacity.permission);
        const minRank = permissionRank(tool.minPermission);
        if (capacityRank === undefined || minRank === undefined) {
            return this.deny(
                'permission-denied',
                `无法比较权限级别（capacity.permission='${capacity.permission}', minPermission='${tool.minPermission}'）`,
            );
        }
        if (capacityRank < minRank) {
            return this.deny(
                'permission-denied',
                `工具 '${toolName}' 要求 minPermission='${tool.minPermission}'，实际 capacity.permission='${capacity.permission}'`,
            );
        }
        // 3. 参数 schema（mini JSON-Schema 子集，fail-closed）
        if (tool.parameters !== undefined) {
            const issues = validateSchema(tool.parameters, args);
            if (issues.length > 0) {
                const detail = issues
                    .slice(0, 5)
                    .map((issue) => `${issue.path} ${issue.message}`)
                    .join('；');
                return this.deny('schema-violation', `参数不符合 schema：${detail}`);
            }
        }
        // 4. 不可逆拦截（MVP 无审批门，一律拒绝）
        if (tool.irreversible === true) {
            return this.deny(
                'irreversible-blocked',
                `工具 '${toolName}' 标记为 irreversible，MVP 无审批门，一律拒绝`,
            );
        }
        // 5. goal 级 constraints（fail-closed）
        for (let i = 0; i < this.goalConstraints.length; i++) {
            const verdict = this.checkConstraint(this.goalConstraints[i], i, tool);
            if (!verdict.pass) {
                return verdict;
            }
        }
        // 6. 预算：capacity.budget.maxCostUsd 定义时：累计 + 本次预估 > 上限即拒
        const maxCostUsd = capacity.budget.maxCostUsd;
        if (maxCostUsd !== undefined) {
            const estimate = estimatedCostUsd ?? 0;
            const total = this.accumulatedCostUsd + estimate;
            if (total > maxCostUsd) {
                return this.deny(
                    'budget-exceeded',
                    `累计 ${this.accumulatedCostUsd} + 预估 ${estimate} = ${total} > maxCostUsd ${maxCostUsd}`,
                );
            }
        }
        return { pass: true };
    }

    /** 解释单条 Constraint；不支持的解释路径一律拒绝（fail-closed） */
    private checkConstraint(constraint: Constraint, index: number, tool: ToolSpec): PolicyVerdict {
        const where = `goalConstraints[${index}]`;
        switch (constraint.kind) {
            case 'network': {
                const rule = constraint.rule;
                if (rule === 'off') {
                    if (tool.sideEffects.includes('net')) {
                        return this.deny(
                            'constraint-denied',
                            `${where}(network) rule='off'：禁止含 'net' 副作用的工具 '${tool.name}'`,
                        );
                    }
                    return { pass: true };
                }
                if (rule === 'on') {
                    return { pass: true };
                }
                return this.deny(
                    'constraint-denied',
                    `${where}(network) rule='${rule}' 不受支持（仅支持 'on'/'off'）`,
                );
            }
            case 'forbidden-resource': {
                const scopes = constraint.rule
                    .split(',')
                    .map((item) => item.trim())
                    .filter((item) => item.length > 0);
                for (const scope of scopes) {
                    if (!KNOWN_SCOPES.has(scope)) {
                        return this.deny(
                            'constraint-denied',
                            `${where}(forbidden-resource) rule 含未知 scope '${scope}'`,
                        );
                    }
                }
                const hit = tool.sideEffects.find((scope) => scopes.includes(scope));
                if (hit !== undefined) {
                    return this.deny(
                        'constraint-denied',
                        `${where}(forbidden-resource) rule='${constraint.rule}'：工具 '${tool.name}' 副作用域 '${hit}' 命中禁止资源`,
                    );
                }
                return { pass: true };
            }
            default: {
                // spend / compliance / data-boundary / custom / 未知 kind：存在即拒
                return this.deny(
                    'constraint-denied',
                    `${where} kind='${constraint.kind}' 不受支持（unsupported-kind，仅支持 network/forbidden-resource）`,
                );
            }
        }
    }

    private deny(code: PolicyDenyCode, detail: string): PolicyVerdict {
        return { pass: false, reason: `${code}: ${detail}` };
    }
}
