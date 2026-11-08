import { describe, expect, it } from 'vitest';
import {
    createVoiceState,
    isActivePhase,
    isListeningPhase,
    reduceVoiceState,
} from '../src/voice/state.ts';

describe('voice state machine', () => {
    it('starts off and enabling moves to requesting', () => {
        const off = createVoiceState();
        expect(off.phase).toBe('off');
        expect(isActivePhase(off.phase)).toBe(false);

        const requesting = reduceVoiceState(off, { type: 'enable' });
        expect(requesting.phase).toBe('requesting');
        expect(requesting.enabled).toBe(true);
        expect(requesting.error).toBeNull();

        const armed = reduceVoiceState(requesting, { type: 'ready', engine: 'local' });
        expect(armed.phase).toBe('armed');
        expect(armed.engine).toBe('local');
        expect(isListeningPhase(armed.phase)).toBe(true);
    });

    it('walks the capture → partial → finalizing → committed path', () => {
        let state = createVoiceState({ phase: 'armed', enabled: true, engine: 'local' });
        state = reduceVoiceState(state, { type: 'vad-start' });
        expect(state.phase).toBe('capturing');

        state = reduceVoiceState(state, { type: 'partial', text: '帮我改', revision: 1 });
        expect(state.phase).toBe('partial');
        expect(state.partial).toBe('帮我改');

        state = reduceVoiceState(state, { type: 'endpoint' });
        expect(state.phase).toBe('finalizing');

        state = reduceVoiceState(state, { type: 'final', text: '帮我改一下这个文件。' });
        expect(state.phase).toBe('committed');
        expect(state.lastFinal).toBe('帮我改一下这个文件。');
        expect(state.partial).toBe('');
    });

    it('drops stale partial revisions', () => {
        let state = createVoiceState({ phase: 'armed', enabled: true });
        state = reduceVoiceState(state, { type: 'vad-start' });
        state = reduceVoiceState(state, { type: 'partial', text: '新', revision: 5 });
        expect(state.revision).toBe(5);
        const stale = reduceVoiceState(state, { type: 'partial', text: '旧', revision: 3 });
        expect(stale.partial).toBe('新');
    });

    it('ignores invalid transitions', () => {
        const off = createVoiceState();
        expect(reduceVoiceState(off, { type: 'vad-start' })).toBe(off);
        expect(reduceVoiceState(off, { type: 'endpoint' })).toBe(off);
        const armed = createVoiceState({ phase: 'armed', enabled: true });
        expect(reduceVoiceState(armed, { type: 'final', text: 'x' })).toBe(armed);
        expect(reduceVoiceState(armed, { type: 'countdown', endsAt: 1 }).countdownEndsAt).toBeNull();
    });

    it('sets and cancels the auto-send countdown', () => {
        let state = createVoiceState({ phase: 'committed', enabled: true });
        state = reduceVoiceState(state, { type: 'countdown', endsAt: 1234 });
        expect(state.countdownEndsAt).toBe(1234);
        state = reduceVoiceState(state, { type: 'countdown-cancel' });
        expect(state.countdownEndsAt).toBeNull();
    });

    it('typing cancels countdown and discards the in-flight utterance', () => {
        let state = createVoiceState({
            phase: 'committed',
            enabled: true,
            lastFinal: '你好',
            countdownEndsAt: 999,
        });
        state = reduceVoiceState(state, { type: 'user-input' });
        expect(state.phase).toBe('armed');
        expect(state.countdownEndsAt).toBeNull();

        let capturing = createVoiceState({
            phase: 'partial',
            enabled: true,
            partial: '你好',
            revision: 2,
        });
        capturing = reduceVoiceState(capturing, { type: 'user-input' });
        expect(capturing.phase).toBe('armed');
        expect(capturing.partial).toBe('');
        expect(capturing.revision).toBe(0);
    });

    it('pause keeps the enabled preference and resume requests again', () => {
        let state = createVoiceState({
            phase: 'committed',
            enabled: true,
            lastFinal: 'abc',
            countdownEndsAt: 1,
        });
        state = reduceVoiceState(state, { type: 'pause', reason: 'blur' });
        expect(state.phase).toBe('paused');
        expect(state.enabled).toBe(true);
        expect(state.pauseReason).toBe('blur');
        expect(state.countdownEndsAt).toBeNull();

        state = reduceVoiceState(state, { type: 'resume' });
        expect(state.phase).toBe('requesting');
        expect(state.pauseReason).toBeNull();
    });

    it('error is recoverable through dismiss-error', () => {
        const state = createVoiceState({
            phase: 'requesting',
            enabled: true,
        });
        const errored = reduceVoiceState(state, {
            type: 'fail',
            code: 'engine_unavailable',
            message: '本机识别不可用',
            retryable: true,
        });
        expect(errored.phase).toBe('error');
        expect(errored.error?.code).toBe('engine_unavailable');
        expect(errored.partial).toBe('');

        const retry = reduceVoiceState(errored, { type: 'dismiss-error' });
        expect(retry.phase).toBe('requesting');
        expect(retry.error).toBeNull();

        const disabled = reduceVoiceState(
            { ...errored, enabled: false },
            { type: 'dismiss-error' },
        );
        expect(disabled.phase).toBe('off');
    });

    it('disable returns to off', () => {
        const state = createVoiceState({ phase: 'armed', enabled: true, engine: 'local' });
        const off = reduceVoiceState(state, { type: 'disable' });
        expect(off.phase).toBe('off');
        expect(off.enabled).toBe(false);
        expect(off.engine).toBeNull();
    });

    it('reset clears transient state on conversation switch', () => {
        const state = createVoiceState({
            phase: 'partial',
            enabled: true,
            partial: '旧会话',
            countdownEndsAt: 1,
        });
        const reset = reduceVoiceState(state, { type: 'reset' });
        expect(reset.phase).toBe('armed');
        expect(reset.partial).toBe('');
        expect(reset.countdownEndsAt).toBeNull();
    });
});
