import { describe, expect, it } from 'vitest';

import { ApprovalTelemetry } from '../src/authz/telemetry.js';

function telemetry(): ApprovalTelemetry {
    const t = new ApprovalTelemetry();
    t.record({ taskType: 'deploy', necessary: true, granted: true, latencyMs: 100 });
    t.record({ taskType: 'deploy', necessary: false, granted: false, latencyMs: 200 });
    t.record({ taskType: 'deploy', necessary: true, granted: true, latencyMs: 300 });
    return t;
}

describe('authz approval telemetry', () => {
    it('computes the approval necessity rate R', () => {
        expect(telemetry().approvalNecessityRate('deploy')).toBeCloseTo(2 / 3);
    });

    it('computes median latency F1', () => {
        expect(telemetry().medianLatency('deploy')).toBe(200);
    });

    it('computes consent-rate drift F2', () => {
        expect(telemetry().consentRate('deploy')).toBeCloseTo(2 / 3);
        expect(telemetry().consentDrift('deploy', 0.9)).toBeCloseTo(0.9 - 2 / 3);
    });

    it('raises R and F2 alerts against thresholds', () => {
        const alerts = telemetry().alerts('deploy', 0.9, {
            minNecessityRate: 0.9,
            maxConsentDrift: 0.1,
        });
        expect(alerts.map((a) => a.metric)).toEqual(['R', 'F2']);
    });
});
