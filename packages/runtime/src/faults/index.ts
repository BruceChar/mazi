export { type FaultContext, parseCode, toFault, toFaultFromResult } from './normalize.js';
export {
    backoffDelay,
    DefaultFaultPipeline,
    type FaultEventType,
    type FaultPipeline,
    type FaultPipelineDeps,
    isEscalation,
} from './pipeline.js';
export { CODE_TO_KIND, isFatalSeverity, kindFromCode } from './policy.js';
export {
    BUILTIN_FAULT_KINDS,
    DEFAULT_FAULT_POLICY,
    defaultSeverityOf,
    FALLBACK_FAULT_POLICY,
    FAULT_SCOPES,
    type Fault,
    type FaultAction,
    type FaultDomainPolicy,
    type FaultFix,
    type FaultPolicy,
    type FaultPolicyTable,
    type FaultRecovery,
    type FaultScope,
    type FaultSeverity,
} from './types.js';
