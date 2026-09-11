/**
 * External-tool trust ladder T0→T1→T2 (§4.6, N6).
 *
 * The ladder only dissolves R4's opacity penalty — it never touches the R1/R2
 * floors. Every promotion is root-signed; demotion is immediate and automatic.
 * A tool that upgrades across versions falls back to T0.
 */

import { contentVersion } from './hash.js';
import type { EffectTier } from './types.js';

export type TrustTier = 'T0' | 'T1' | 'T2';

export const N_MIN = 200;
export const TAU_KL = 0.1;

export interface BehaviorSignature {
    domain: string;
    effectClass: string;
    targetBucket: string;
    argShape: string;
    transferDir: 'none' | 'ingest' | 'egress';
    frequency: string;
    verdictPath: EffectTier | 'approval';
}

function typeTree(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(typeTree).join(',')}]`;
    if (typeof value === 'object') {
        return (
            '{' +
            Object.keys(value as object)
                .sort()
                .join(',') +
            '}'
        );
    }
    return typeof value;
}

export function argShapeOf(args: unknown): string {
    return typeTree(args);
}

export function targetBucketOf(target: string): string {
    const parts = target.split('/').filter(Boolean);
    return parts.slice(0, 2).join('/');
}

export function frequencyBucket(count: number): string {
    if (count < 10) return '<10';
    if (count < 100) return '<100';
    if (count < 1000) return '<1000';
    return '>=1000';
}

export function signatureOf(call: {
    domain: string;
    effectClass: string;
    target: string;
    args: unknown;
    transferDir: BehaviorSignature['transferDir'];
    frequency: number;
    verdictPath: BehaviorSignature['verdictPath'];
}): BehaviorSignature {
    return {
        domain: call.domain,
        effectClass: call.effectClass,
        targetBucket: targetBucketOf(call.target),
        argShape: argShapeOf(call.args),
        transferDir: call.transferDir,
        frequency: frequencyBucket(call.frequency),
        verdictPath: call.verdictPath,
    };
}

export function signatureKey(sig: BehaviorSignature): string {
    return [
        sig.domain,
        sig.effectClass,
        sig.targetBucket,
        sig.argShape,
        sig.transferDir,
        sig.frequency,
        sig.verdictPath,
    ].join('|');
}

export interface LadderWindow {
    calls: BehaviorSignature[];
    dangerEvents: number;
}

export interface StabilityReport {
    stable: boolean;
    mode: 'set' | 'distribution';
    reason: string;
}

function setValues(
    signatures: readonly BehaviorSignature[],
    selector: (s: BehaviorSignature) => string,
): Set<string> {
    return new Set(signatures.map(selector));
}

function hasNovel(
    current: readonly BehaviorSignature[],
    baseline: readonly BehaviorSignature[],
    selector: (s: BehaviorSignature) => string,
): boolean {
    const known = setValues(baseline, selector);
    return current.some((s) => !known.has(selector(s)));
}

/** Smoothed KL divergence over the 7-field signature key distribution. */
export function klDivergence(
    current: readonly BehaviorSignature[],
    baseline: readonly BehaviorSignature[],
    epsilon = 1e-6,
): number {
    const currentCounts = new Map<string, number>();
    const baselineCounts = new Map<string, number>();
    for (const s of current)
        currentCounts.set(signatureKey(s), (currentCounts.get(signatureKey(s)) ?? 0) + 1);
    for (const s of baseline)
        baselineCounts.set(signatureKey(s), (baselineCounts.get(signatureKey(s)) ?? 0) + 1);
    const keys = new Set([...currentCounts.keys(), ...baselineCounts.keys()]);
    const totalCurrent = current.length || 1;
    const totalBaseline = baseline.length || 1;
    const size = keys.size || 1;
    let divergence = 0;
    for (const key of keys) {
        const p = ((currentCounts.get(key) ?? 0) + epsilon) / (totalCurrent + epsilon * size);
        const q = ((baselineCounts.get(key) ?? 0) + epsilon) / (totalBaseline + epsilon * size);
        divergence += p * Math.log(p / q);
    }
    return divergence;
}

/**
 * Small-sample window: set comparison (no KL estimation noise). Sufficient
 * sample: distribution drift. Any danger/boundary event is immediately
 * unstable.
 */
export function assessStability(
    window: LadderWindow,
    baseline: readonly BehaviorSignature[],
    opts: { nMin?: number; tauKl?: number } = {},
): StabilityReport {
    const nMin = opts.nMin ?? N_MIN;
    const tauKl = opts.tauKl ?? TAU_KL;
    if (window.dangerEvents > 0) {
        return { stable: false, mode: 'set', reason: '窗口内出现 danger/boundary 事件' };
    }
    if (window.calls.length < nMin) {
        const novel =
            hasNovel(window.calls, baseline, (s) => s.targetBucket) ||
            hasNovel(window.calls, baseline, (s) => s.effectClass) ||
            hasNovel(window.calls, baseline, (s) => s.verdictPath);
        return novel
            ? {
                  stable: false,
                  mode: 'set',
                  reason: '小样本期集合出现新增 targetBucket/effectClass/verdictPath',
              }
            : { stable: true, mode: 'set', reason: '小样本期集合无新增' };
    }
    const divergence = klDivergence(window.calls, baseline);
    return divergence < tauKl
        ? { stable: true, mode: 'distribution', reason: `D_KL=${divergence.toFixed(4)} < ${tauKl}` }
        : {
              stable: false,
              mode: 'distribution',
              reason: `D_KL=${divergence.toFixed(4)} ≥ ${tauKl}`,
          };
}

export interface LadderRecord {
    tier: TrustTier;
    version: string;
    baseline: BehaviorSignature[];
    window: LadderWindow;
}

export interface R4Effect {
    /** T0 keeps the worst-role floor; T1/T2 use the declared role. */
    floor: 'worst-role' | 'declared-role';
}

export class TrustLadder {
    private readonly records = new Map<string, LadderRecord>();

    register(tool: string, version: string): LadderRecord {
        const record: LadderRecord = {
            tier: 'T0',
            version,
            baseline: [],
            window: { calls: [], dangerEvents: 0 },
        };
        this.records.set(tool, record);
        return record;
    }

    recordCall(tool: string, signature: BehaviorSignature, opts: { danger?: boolean } = {}): void {
        const record = this.records.get(tool);
        if (!record) return;
        record.window.calls.push(signature);
        if (opts.danger) record.window.dangerEvents += 1;
    }

    /** Quarterly forced re-baseline; also run after a successful trial window. */
    commitBaseline(tool: string): void {
        const record = this.records.get(tool);
        if (!record) return;
        record.baseline = [...record.window.calls];
        record.window = { calls: [], dangerEvents: 0 };
    }

    /** Promotions happen only via root signature (N6); anything else throws. */
    promote(tool: string, tier: TrustTier, rootSigned: boolean): void {
        if (!rootSigned) {
            throw new Error('信任阶梯升级必须由根层签署（提示/模型请求/工具自述永不触发）');
        }
        const record = this.records.get(tool);
        if (!record) throw new Error(`未注册工具：${tool}`);
        record.tier = tier;
    }

    /** Evaluate stability; an unstable window demotes immediately to T0. */
    evaluate(
        tool: string,
        opts: { nMin?: number; tauKl?: number } = {},
    ): {
        tier: TrustTier;
        report: StabilityReport;
        demoted: boolean;
    } {
        const record = this.records.get(tool);
        if (!record) throw new Error(`未注册工具：${tool}`);
        const report = assessStability(record.window, record.baseline, opts);
        if (!report.stable && record.tier !== 'T0') {
            record.tier = 'T0';
            record.window = { calls: [], dangerEvents: 0 };
            return { tier: 'T0', report, demoted: true };
        }
        return { tier: record.tier, report, demoted: false };
    }

    /** A cross-version upgrade is treated as a new tool and falls back to T0. */
    onVersionChange(tool: string, version: string): LadderRecord {
        const record = this.records.get(tool);
        if (record && record.version !== version) {
            return this.register(tool, version);
        }
        return record ?? this.register(tool, version);
    }

    /** N6: the ladder only dissolves the R4 opacity penalty. */
    r4Effect(tool: string): R4Effect {
        const record = this.records.get(tool);
        const tier = record?.tier ?? 'T0';
        return tier === 'T0' ? { floor: 'worst-role' } : { floor: 'declared-role' };
    }

    tierOf(tool: string): TrustTier {
        return this.records.get(tool)?.tier ?? 'T0';
    }

    versionHash(): number {
        return contentVersion([...this.records.entries()].map(([tool, r]) => [tool, r.tier]));
    }
}
