/**
 * voice-capture AudioWorkletProcessor（纯 JS，无构建依赖）。
 *
 * 输入：浏览器 AudioContext 采样率（可能 44.1k / 48k / 16k）；
 * 输出：16kHz / mono / Int16 PCM 帧（默认 100ms = 1600 samples）+ RMS 电平，
 *      transferable ArrayBuffer 发回主线程。
 *
 * 设计：docs/web/语音输入设计.md §6.5 / P0 采集链路。
 */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processorOptions = (options && options.processorOptions) || {};
        this.inputSampleRate = processorOptions.inputSampleRate || sampleRate || 48000;
        this.targetSampleRate = processorOptions.targetSampleRate || 16000;
        this.frameSamples =
            processorOptions.frameSamples ||
            Math.round(this.targetSampleRate * 0.1);
        this.ratio = this.inputSampleRate / this.targetSampleRate;
        this.pending = new Float32Array(0);
        this.pos = 0;
        this.frame = new Int16Array(this.frameSamples);
        this.frameOffset = 0;
        this.sumSquares = 0;
        this.port.postMessage({
            type: 'ready',
            inputSampleRate: this.inputSampleRate,
            targetSampleRate: this.targetSampleRate,
            frameSamples: this.frameSamples,
        });
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const frames = input[0] ? input[0].length : 0;
        if (!frames) return true;

        // 多声道 downmix 为 mono。
        const mono = new Float32Array(frames);
        for (let channel = 0; channel < input.length; channel += 1) {
            const data = input[channel];
            if (!data) continue;
            for (let i = 0; i < frames; i += 1) mono[i] += data[i];
        }
        if (input.length > 1) {
            for (let i = 0; i < frames; i += 1) mono[i] /= input.length;
        }

        // 追加到重采样缓冲。
        const merged = new Float32Array(this.pending.length + frames);
        merged.set(this.pending, 0);
        merged.set(mono, this.pending.length);
        this.pending = merged;

        // 线性插值重采样到 targetSampleRate，并切帧。
        let produced = 0;
        while (Math.floor(this.pos) + 1 < this.pending.length) {
            const base = Math.floor(this.pos);
            const frac = this.pos - base;
            const sample =
                this.pending[base] * (1 - frac) + this.pending[base + 1] * frac;
            this.pushSample(sample);
            this.pos += this.ratio;
            produced += 1;
            if (produced > 1 << 20) break;
        }
        const drop = Math.floor(this.pos);
        if (drop > 0) {
            this.pending = this.pending.slice(drop);
            this.pos -= drop;
        }
        return true;
    }

    pushSample(sample) {
        const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
        this.sumSquares += clamped * clamped;
        this.frame[this.frameOffset] =
            clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        this.frameOffset += 1;
        if (this.frameOffset >= this.frameSamples) this.emitFrame();
    }

    emitFrame() {
        const pcm = this.frame;
        const level = Math.sqrt(this.sumSquares / this.frameSamples);
        this.frame = new Int16Array(this.frameSamples);
        this.frameOffset = 0;
        this.sumSquares = 0;
        this.port.postMessage(
            {
                type: 'audio',
                pcm: pcm.buffer,
                level: level,
                at: currentTime * 1000,
                sampleRate: this.targetSampleRate,
            },
            [pcm.buffer],
        );
    }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
