/**
 * Approval-fatigue telemetry (V3 §6.3.3, G7).
 *
 * R = necessary approvals / total approvals; F1 = latency against the task-type
 * baseline; F2 = consent-rate drift against the task-type baseline. F2 drift is
 * the most important health signal: it precedes the defence being normalized
 * away. Pure measurement — no enforcement.
 */

export interface ApprovalSample {
    taskType: string;
    necessary: boolean;
    granted: boolean;
    latencyMs: number;
}

export interface TelemetryThresholds {
    /** Below this R over a window, flag the source annotations for review. */
    minNecessityRate?: number;
    /** Above this consent-rate drift, raise the highest-priority alert. */
    maxConsentDrift?: number;
}

export interface TelemetryAlert {
    metric: 'R' | 'F2';
    value: number;
    threshold: number;
    message: string;
}

function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export class ApprovalTelemetry {
    private readonly samples: ApprovalSample[] = [];

    record(sample: ApprovalSample): void {
        this.samples.push(sample);
    }

    get size(): number {
        return this.samples.length;
    }

    /** R: approval necessity rate (conservative default 0 when no sample). */
    approvalNecessityRate(taskType?: string): number {
        const window = this.window(taskType);
        if (window.length === 0) return 0;
        const necessary = window.filter((s) => s.necessary).length;
        return necessary / window.length;
    }

    /** F1: median approval latency. */
    medianLatency(taskType?: string): number {
        return median(this.window(taskType).map((s) => s.latencyMs));
    }

    consentRate(taskType: string): number {
        const window = this.window(taskType);
        if (window.length === 0) return 0;
        return window.filter((s) => s.granted).length / window.length;
    }

    /** F2: absolute consent-rate drift against a task-type baseline. */
    consentDrift(taskType: string, baseline: number): number {
        return Math.abs(this.consentRate(taskType) - baseline);
    }

    alerts(
        taskType: string,
        baseline: number,
        thresholds: TelemetryThresholds = {},
    ): TelemetryAlert[] {
        const alerts: TelemetryAlert[] = [];
        const minR = thresholds.minNecessityRate;
        if (minR !== undefined && this.approvalNecessityRate(taskType) < minR) {
            alerts.push({
                metric: 'R',
                value: this.approvalNecessityRate(taskType),
                threshold: minR,
                message: '审批必要率低于阈值：触发来源资产标注复审',
            });
        }
        const maxDrift = thresholds.maxConsentDrift;
        const drift = this.consentDrift(taskType, baseline);
        if (maxDrift !== undefined && drift > maxDrift) {
            alerts.push({
                metric: 'F2',
                value: drift,
                threshold: maxDrift,
                message: '同意率漂移超阈：审批机制可能正被习惯化绕过，需根层审阅',
            });
        }
        return alerts;
    }

    private window(taskType?: string): ApprovalSample[] {
        return taskType === undefined
            ? this.samples
            : this.samples.filter((s) => s.taskType === taskType);
    }
}
