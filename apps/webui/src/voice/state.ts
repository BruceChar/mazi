/**
 * 语音状态机：纯 reducer，不依赖 DOM，可单测（设计 §5.2）。
 *
 * 阶段迁移：
 *   off --enable--> requesting --ready--> armed --vad-start--> capturing
 *   capturing --partial--> partial --endpoint--> finalizing --final--> committed
 *   active --pause--> paused --resume--> requesting
 *   any --fail--> error --dismiss--> requesting/off
 */
import type { VoiceErrorInfo, VoiceEvent, VoiceState } from './types.ts';

export function createVoiceState(overrides: Partial<VoiceState> = {}): VoiceState {
    return {
        phase: 'off',
        enabled: false,
        engine: null,
        partial: '',
        revision: 0,
        lastFinal: '',
        countdownEndsAt: null,
        error: null,
        pauseReason: null,
        ...overrides,
    };
}

const ACTIVE_PHASES: readonly VoiceState['phase'][] = [
    'requesting',
    'armed',
    'capturing',
    'partial',
    'finalizing',
    'committed',
];

export function isActivePhase(phase: VoiceState['phase']): boolean {
    return ACTIVE_PHASES.includes(phase);
}

export function isListeningPhase(phase: VoiceState['phase']): boolean {
    return phase === 'armed' || phase === 'capturing' || phase === 'partial';
}

/** 处于可被暂停 / 需要释放采集的阶段。 */
export function canPause(phase: VoiceState['phase']): boolean {
    return isActivePhase(phase) || phase === 'paused';
}

function clearTransient(state: VoiceState): VoiceState {
    return { ...state, partial: '', revision: 0, countdownEndsAt: null };
}

/** 默认事件；未知事件返回原状态（调用方不需要兜底）。 */
export function reduceVoiceState(
    state: VoiceState,
    event: VoiceEvent | { type: string; [key: string]: unknown },
): VoiceState {
    switch (event.type) {
        case 'enable':
            return {
                ...clearTransient(state),
                phase: 'requesting',
                enabled: true,
                error: null,
                pauseReason: null,
            };
        case 'ready': {
            const ready = event as Extract<VoiceEvent, { type: 'ready' }>;
            if (state.phase !== 'requesting' && state.phase !== 'off') return state;
            return {
                ...state,
                phase: 'armed',
                engine: ready.engine,
                error: null,
                pauseReason: null,
            };
        }
        case 'fail': {
            const fail = event as Extract<VoiceEvent, { type: 'fail' }>;
            const error: VoiceErrorInfo = {
                code: fail.code,
                message: fail.message,
                retryable: fail.retryable,
            };
            return { ...clearTransient(state), phase: 'error', error, enabled: true };
        }
        case 'vad-start':
            if (state.phase === 'armed' || state.phase === 'committed') {
                return {
                    ...state,
                    phase: 'capturing',
                    partial: '',
                    revision: 0,
                    countdownEndsAt: null,
                    error: null,
                };
            }
            return state;
        case 'partial': {
            const partial = event as Extract<VoiceEvent, { type: 'partial' }>;
            if (state.phase !== 'capturing' && state.phase !== 'partial') return state;
            // revision 单调：丢弃乱序/过期 partial。
            if (partial.revision != null && partial.revision < state.revision) return state;
            return {
                ...state,
                phase: 'partial',
                partial: partial.text,
                revision: partial.revision ?? state.revision + 1,
            };
        }
        case 'endpoint':
            if (state.phase !== 'capturing' && state.phase !== 'partial') return state;
            return { ...state, phase: 'finalizing' };
        case 'final': {
            const final = event as Extract<VoiceEvent, { type: 'final' }>;
            if (
                state.phase !== 'capturing' &&
                state.phase !== 'partial' &&
                state.phase !== 'finalizing'
            ) {
                return state;
            }
            return {
                ...state,
                phase: 'committed',
                partial: '',
                revision: 0,
                lastFinal: final.text,
                countdownEndsAt: null,
                error: null,
            };
        }
        case 'countdown': {
            const countdown = event as Extract<VoiceEvent, { type: 'countdown' }>;
            if (state.phase !== 'committed') return state;
            return { ...state, countdownEndsAt: countdown.endsAt };
        }
        case 'countdown-cancel':
            return { ...state, countdownEndsAt: null };
        case 'pause': {
            const pause = event as Extract<VoiceEvent, { type: 'pause' }>;
            if (!canPause(state.phase)) return state;
            if (state.phase === 'paused') {
                return { ...state, pauseReason: pause.reason };
            }
            return {
                ...clearTransient(state),
                phase: 'paused',
                enabled: state.enabled,
                pauseReason: pause.reason,
            };
        }
        case 'resume':
            if (state.phase !== 'paused' && state.phase !== 'error' && state.phase !== 'off') {
                return state;
            }
            return {
                ...clearTransient(state),
                phase: 'requesting',
                enabled: true,
                error: null,
                pauseReason: null,
            };
        case 'disable':
            return {
                ...clearTransient(state),
                phase: 'off',
                enabled: false,
                engine: null,
                error: null,
                pauseReason: null,
            };
        case 'user-input': {
            // 打字 / 用户继续输入：取消倒计时；正在采集的 utterance 直接丢弃。
            const next = { ...state, countdownEndsAt: null };
            if (
                next.phase === 'capturing' ||
                next.phase === 'partial' ||
                next.phase === 'finalizing' ||
                next.phase === 'committed'
            ) {
                return { ...next, phase: 'armed', partial: '', revision: 0 };
            }
            return next;
        }
        case 'dismiss-error':
            if (state.phase !== 'error') return state;
            return {
                ...clearTransient(state),
                phase: state.enabled ? 'requesting' : 'off',
                error: null,
                pauseReason: null,
            };
        case 'reset': {
            // 会话切换：取消倒计时 / 丢弃当前 utterance，但保持监听。
            const next = { ...state, countdownEndsAt: null, partial: '', revision: 0 };
            if (
                next.phase === 'capturing' ||
                next.phase === 'partial' ||
                next.phase === 'finalizing' ||
                next.phase === 'committed'
            ) {
                return { ...next, phase: next.enabled ? 'armed' : 'off' };
            }
            return next;
        }
        default:
            return state;
    }
}
