import { describe, expect, it } from 'vitest';
import { EnergyVad } from '../src/voice/vad.ts';

/** 以 100ms 帧喂入固定电平，收集事件。 */
function feedFrames(vad: EnergyVad, level: number, count: number, startAt: number) {
    const events = [];
    for (let i = 0; i < count; i += 1) {
        const at = startAt + i * 100;
        for (const event of vad.feed(level, at)) events.push({ ...event, at });
    }
    return events;
}

function calibrateSilence(vad: EnergyVad, level = 0.002, frames = 20) {
    for (let i = 0; i < frames; i += 1) vad.feed(level, i * 100);
}

describe('energy VAD', () => {
    it('stays silent on quiet frames', () => {
        const vad = new EnergyVad();
        const events = feedFrames(vad, 0.002, 20, 0);
        expect(events.filter((event) => event.type === 'start')).toHaveLength(0);
        expect(events.filter((event) => event.type === 'end')).toHaveLength(0);
        expect(vad.speechActive).toBe(false);
        expect(events.some((event) => event.type === 'level')).toBe(true);
    });

    it('requires ~150ms of speech to start', () => {
        const vad = new EnergyVad();
        calibrateSilence(vad);
        // 第一帧高电平不足 150ms，不触发。
        const first = vad.feed(0.2, 2000);
        expect(first.some((event) => event.type === 'start')).toBe(false);
        const second = vad.feed(0.2, 2100);
        expect(second.some((event) => event.type === 'start')).toBe(false);
        const third = vad.feed(0.2, 2200);
        const start = third.find((event) => event.type === 'start');
        expect(start).toMatchObject({ type: 'start', at: 2000 });
        expect(vad.speechActive).toBe(true);
    });

    it('ends after endpointSilenceMs of silence (default 700ms)', () => {
        const vad = new EnergyVad();
        calibrateSilence(vad);
        feedFrames(vad, 0.2, 3, 2000);
        const silence = feedFrames(vad, 0.001, 8, 2300);
        const end = silence.find((event) => event.type === 'end');
        expect(end).toMatchObject({
            type: 'end',
            durationMs: 900,
            reason: 'silence',
            tooShort: false,
        });
        expect(vad.speechActive).toBe(false);
    });

    it('honours a configurable endpoint', () => {
        const vad = new EnergyVad({ endpointSilenceMs: 300 });
        calibrateSilence(vad);
        feedFrames(vad, 0.2, 3, 2000);
        const silence = feedFrames(vad, 0.001, 5, 2300);
        const end = silence.find((event) => event.type === 'end');
        expect(end).toMatchObject({ type: 'end', reason: 'silence' });
        expect((end as { at: number }).at).toBe(2500);
    });

    it('flags too-short utterances', () => {
        const vad = new EnergyVad({
            speechStartMs: 100,
            endpointSilenceMs: 100,
            minSpeechMs: 300,
        });
        calibrateSilence(vad);
        feedFrames(vad, 0.2, 2, 2000);
        const silence = feedFrames(vad, 0.001, 2, 2200);
        const end = silence.find((event) => event.type === 'end');
        expect(end).toMatchObject({ type: 'end', durationMs: 200, tooShort: true });
    });

    it('forces an end at maxUtteranceMs', () => {
        const vad = new EnergyVad({
            speechStartMs: 100,
            minSpeechMs: 100,
            maxUtteranceMs: 300,
        });
        calibrateSilence(vad);
        const first = feedFrames(vad, 0.2, 2, 2000);
        expect(first.some((event) => event.type === 'start')).toBe(true);
        const more = feedFrames(vad, 0.2, 2, 2200);
        const end = more.find((event) => event.type === 'end');
        expect(end).toMatchObject({ type: 'end', reason: 'max-duration', durationMs: 300 });
    });

    it('adapts the noise floor upward in noisy environments', () => {
        const vad = new EnergyVad();
        expect(vad.currentNoiseFloor).toBeLessThan(0.005);
        // 低于初始阈值但高于初始噪声底：静音期会把噪声底抬高。
        feedFrames(vad, 0.006, 100, 0);
        expect(vad.currentNoiseFloor).toBeGreaterThan(0.005);
    });

    it('maps sensitivity to different thresholds', () => {
        const low = new EnergyVad({ sensitivity: 'low' });
        const high = new EnergyVad({ sensitivity: 'high' });
        for (const vad of [low, high]) {
            for (let i = 0; i < 40; i += 1) vad.feed(0.0005, i * 100);
        }
        expect(low.isSpeechLevel(0.008)).toBe(false);
        expect(high.isSpeechLevel(0.008)).toBe(true);
    });

    it('reset() clears the in-flight utterance', () => {
        const vad = new EnergyVad();
        calibrateSilence(vad);
        feedFrames(vad, 0.2, 3, 2000);
        expect(vad.speechActive).toBe(true);
        vad.reset();
        expect(vad.speechActive).toBe(false);
        const events = feedFrames(vad, 0.001, 2, 3000);
        expect(events.some((event) => event.type === 'end')).toBe(false);
    });
});
