/**
 * Permission-level and effect-scope vocabulary shared by the goal model, the
 * runtime config and the observability contract.
 *
 * `PermissionLevel` is the human-facing goal ceiling (the UI's text / read-only
 * / draft / approved / autonomous selector) and an index into the v2 grant
 * presets — it is never an enforce decision. Enforcement reads the v2
 * `EffectivePolicy` (see authz/). `SideEffectScope` is descriptive metadata
 * for observability and tool-directory lookup; it does not participate in
 * dispatch.
 */

export type PermissionLevel =
    | 'text' // text-only generation, no effects
    | 'read-only' // readable, not writable
    | 'draft' // writes to the staging area
    | 'approved' // external actions after approval
    | 'autonomous' // constrained autonomy
    | (string & {});

/** Coarse effect classification for observability aggregation only. */
export type SideEffectScope =
    | 'fs'
    | 'net'
    | 'process'
    | 'db'
    | 'pay'
    | 'external-api'
    | (string & {});

/**
 * Approval scope. `generation` is the v2 generation-level informed
 * attestation (A2b): egress calls in the generation are silently allowed once
 * signed.
 */
export type ApprovalScope = 'once' | 'session' | 'workspace' | 'generation';
