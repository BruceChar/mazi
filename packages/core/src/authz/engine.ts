/**
 * AuthorizationEngine — the composition root of the authorization v2 layer.
 *
 * Binds the label registry, role registry, backend capability matrix, dataflow
 * ledger and derived-label overlay into the derive / adjudicate / apply flow
 * described by AHF_CORE_AUTHORIZATION_V2.md. The ToolGateway (enforcement
 * pipeline) consumes this engine rather than reaching into the components.
 */

import { type DeriveContext, derive } from './derive.js';
import type { AssetLabelRegistry } from './labels.js';
import {
    type ConditionVerdict,
    type DataflowLedger,
    type EgressAttestation,
    evaluateNoSensitiveIngest,
    type GenerationTrigger,
    type InheritanceMode,
    isAttestationValid,
    type LedgerSnapshot,
    type LedgerWrite,
    makeAttestation,
} from './ledger.js';
import { DerivedLabelOverlayManager, overlayResolve } from './overlay.js';
import type { RoleRegistry } from './roles.js';
import type {
    AgentGrant,
    AssetQuery,
    BackendCapabilities,
    CapabilityKey,
    DerivedLabel,
    DeriveResult,
    EffectivePolicy,
    LedgerVersion,
    PinnedVersions,
    ResolvedLabel,
    TaskPolicyRequest,
    UnenforcedAxisPolicy,
} from './types.js';

export interface EngineAuditSink {
    log(event: { type: string; [key: string]: unknown }): void;
}

export interface AuthorizationEngineOptions {
    labelRegistry: AssetLabelRegistry;
    roles: RoleRegistry;
    backend: BackendCapabilities;
    ledger: DataflowLedger;
    pinned: PinnedVersions;
    rootContractId: string;
    rootVersion: number;
    taskId: string;
    overlay?: DerivedLabelOverlayManager;
    strict?: boolean;
    unenforcedPolicy?: readonly UnenforcedAxisPolicy[];
    isRevoked?: (pinned: PinnedVersions) => boolean;
    resolveTarget?: DeriveContext['resolveTarget'];
    audit?: EngineAuditSink;
    now?: () => number;
}

export class AuthorizationEngine {
    readonly ledger: DataflowLedger;
    readonly overlay: DerivedLabelOverlayManager;
    private policy?: EffectivePolicy;

    constructor(private readonly opts: AuthorizationEngineOptions) {
        this.ledger = opts.ledger;
        this.overlay =
            opts.overlay ??
            new DerivedLabelOverlayManager({ domain: 'workspace', home: opts.labelRegistry.home });
    }

    derive(parent: AgentGrant, request: TaskPolicyRequest): DeriveResult {
        const result = derive(parent, request, {
            rootContractId: this.opts.rootContractId,
            rootVersion: this.opts.rootVersion,
            taskId: this.opts.taskId,
            roles: this.opts.roles,
            backend: this.opts.backend,
            labelRegistry: this.opts.labelRegistry,
            pinned: this.opts.pinned,
            strict: this.opts.strict,
            unenforcedPolicy: this.opts.unenforcedPolicy,
            isRevoked: this.opts.isRevoked,
            resolveTarget: this.opts.resolveTarget,
        });
        if (result.ok) this.policy = result.policy;
        return result;
    }

    currentPolicy(): EffectivePolicy | undefined {
        return this.policy;
    }

    /** N15 + overlay merge; the `fromOverlay` flag marks flow-only tightening. */
    resolveAsset(query: AssetQuery): ResolvedLabel {
        const base = this.opts.labelRegistry.resolve(query);
        return query.kind === 'path' ? overlayResolve(base, query.value, this.overlay) : base;
    }

    /** Record a read event at the ledger's linearization point. */
    commitRead(write: LedgerWrite): LedgerVersion {
        return this.ledger.commit(this.ledger.beginWrite(), write);
    }

    /** Evaluation point ⑩: apply the derived-label overlay on write. */
    applyWrite(target: string, snapshot?: LedgerSnapshot): DerivedLabel | undefined {
        return this.overlay.apply(target, this.ledger, snapshot);
    }

    /**
     * R3-flow runtime adjudication: `not-applicable` when the capability
     * carries no condition; otherwise the ledger verdict (missing ledger state
     * is broken, N5).
     */
    judgeCondition(capability: CapabilityKey): ConditionVerdict | 'not-applicable' {
        const effective = this.policy?.capabilities[capability];
        if (!effective || effective.conditions.length === 0) return 'not-applicable';
        return evaluateNoSensitiveIngest(this.ledger.snapshot());
    }

    attestEgress(attestor: string, scope: string): EgressAttestation {
        const snapshot = this.ledger.snapshot();
        const attestation = makeAttestation(
            attestor,
            scope,
            snapshot,
            this.opts.now?.() ?? Date.now(),
        );
        this.opts.audit?.log({ type: 'generation-egress-attestation', ...attestation });
        return attestation;
    }

    isAttestationValid(attestation: EgressAttestation): boolean {
        return isAttestationValid(attestation, this.ledger.snapshot());
    }

    /** User flush: clears the ledger only; overlays are untouched (N20/P26). */
    flush(): LedgerSnapshot {
        return this.ledger.switchGeneration('user');
    }

    switchGeneration(trigger: GenerationTrigger, mode: InheritanceMode = 'full'): LedgerSnapshot {
        return this.ledger.switchGeneration(trigger, mode);
    }

    clearOverlay(target: string, attestor: string, reason: string): boolean {
        return this.overlay.clear(target, attestor, reason);
    }
}
