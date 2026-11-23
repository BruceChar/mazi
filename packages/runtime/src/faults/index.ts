export { FaultContext, parseCode, toFault, toFaultFromResult } from './normalize.js';
export type { FaultPipeline } from './pipeline.js';
export {
    backoffDelay,
    DefaultFaultPipeline,
    FaultDomainPolicy,
    FaultEventType,
    FaultPipelineDeps,
    isEscalation,
} from './pipeline.js';
export { CODE_TO_KIND, isFatalSeverity, kindFromCode } from './policy.js';
