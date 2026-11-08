import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { VoiceInstallStatus, VoiceModelInfo } from '@mazi/libs';
import type {
    SenseVoiceHost,
    SenseVoiceModelStore,
    SenseVoicePaths,
    SenseVoiceTranscribeInput,
} from '../src/voice/sensevoice/types.js';
import { voiceSenseVoicePlugin } from '../src/voice/sensevoice/plugin.js';

class FakeStore implements SenseVoiceModelStore {
    installedFlag = true;
    status: VoiceInstallStatus | undefined = {
        modelId: 'sensevoice-small-int8',
        status: 'done',
        progress: 1,
    };
    paths(): SenseVoicePaths | null {
        return this.installedFlag
            ? { model: '/m/model.int8.onnx', tokens: '/m/tokens.txt', vad: '/m/silero_vad.onnx' }
            : null;
    }
    installed(): boolean {
        return this.installedFlag;
    }
    modelInfo(): VoiceModelInfo {
        return {
            id: 'sensevoice-small-int8',
            name: 'SenseVoice Small',
            description: 'fake',
            languages: ['zh', 'en'],
            sizeBytes: 241_357_257,
            license: 'Apache-2.0',
            installed: this.installedFlag,
            recommended: true,
        };
    }
    installStatus(): VoiceInstallStatus | undefined {
        return this.status;
    }
    async ensureInstalled(): Promise<VoiceInstallStatus> {
        return this.status ?? { modelId: 'sensevoice-small-int8', status: 'done', progress: 1 };
    }
    close(): void {}
}

class FakeHost implements SenseVoiceHost {
    lastInput: SenseVoiceTranscribeInput | null = null;
    availability() {
        return { available: true };
    }
    async transcribe(input: SenseVoiceTranscribeInput) {
        this.lastInput = input;
        return { text: '你好 mazi', inferenceMs: 42 };
    }
    closeAll(): void {}
}

describe('SenseVoice API plugin', () => {
    let app: FastifyInstance;
    let store: FakeStore;
    let host: FakeHost;

    beforeAll(async () => {
        app = Fastify({ logger: false });
        store = new FakeStore();
        host = new FakeHost();
        await app.register(voiceSenseVoicePlugin, { store, host });
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    it('capabilities 返回本机 SenseVoice 模型与安装状态', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/voice/capabilities' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.engines.local.available).toBe(true);
        expect(body.models[0].id).toBe('sensevoice-small-int8');
        expect(body.install).toMatchObject({ status: 'done', progress: 1 });
        expect(body.security.loopbackOnly).toBe(true);
    });

    it('整段 PCM 转写', async () => {
        const pcm = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer).toString('base64');
        const res = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/transcribe',
            payload: { audioBase64: pcm, sampleRate: 16000, language: 'zh-CN' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ text: '你好 mazi', inferenceMs: 42 });
        expect(host.lastInput?.sampleRate).toBe(16000);
        expect(host.lastInput?.language).toBe('zh');
    });

    it('空音频 / Origin 不符被拒绝', async () => {
        const empty = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/transcribe',
            payload: { audioBase64: '', sampleRate: 16000 },
        });
        expect(empty.statusCode).toBe(400);
        const denied = await app.inject({
            method: 'GET',
            url: '/api/voice/capabilities',
            headers: { origin: 'https://evil.example' },
        });
        expect(denied.statusCode).toBe(403);
    });

    it('模型未安装时 capabilities 降级', async () => {
        store.installedFlag = false;
        store.status = { modelId: 'sensevoice-small-int8', status: 'running', progress: 0.3 };
        const res = await app.inject({ method: 'GET', url: '/api/voice/capabilities' });
        expect(res.json().engines.local.available).toBe(false);
        expect(res.json().engines.local.reason).toBe('model_missing');
        expect(res.json().install).toMatchObject({ status: 'running', progress: 0.3 });
        store.installedFlag = true;
        store.status = { modelId: 'sensevoice-small-int8', status: 'done', progress: 1 };
    });
});
