import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
    VOICE_DEFAULT_LIMITS,
    VOICE_DEFAULT_MODEL_ID,
    type VoiceInstallStatus,
    type VoiceModelInfo,
} from '@mazi/libs';
import type {
    VoiceEngineHost,
    VoiceEngineOpenOptions,
    VoiceEngineSession,
} from '../src/voice/engine.js';
import type { VoiceModelStore } from '../src/voice/models.js';
import { voicePlugin } from '../src/voice/voice.plugin.js';

class FakeEngine implements VoiceEngineHost {
    available = true;
    opened = 0;
    closed = 0;

    availability() {
        return this.available
            ? { available: true }
            : { available: false, reason: 'sherpa_unavailable' };
    }

    async open(_options: VoiceEngineOpenOptions): Promise<VoiceEngineSession> {
        this.opened += 1;
        let text = '';
        return {
            push: async (pcm: Uint8Array) => {
                text += pcm.length >= 2 ? '你' : '';
                return { partial: text };
            },
            end: async () => ({ text: '你好 mazi' }),
            close: () => {
                this.closed += 1;
            },
        };
    }

    closeAll(): void {
        this.closed += 1;
    }
}

class FakeModels implements VoiceModelStore {
    installedModel = true;
    installStatus: VoiceInstallStatus | undefined = undefined;
    downloads = new Map<
        string,
        { status: 'running' | 'done' | 'error'; progress: number; error?: string }
    >();

    list(): VoiceModelInfo[] {
        return [
            {
                id: VOICE_DEFAULT_MODEL_ID,
                name: 'fake',
                description: 'fake',
                languages: ['zh'],
                sizeBytes: 48 * 1024 * 1024,
                license: 'Apache-2.0',
                installed: this.installedModel,
                recommended: true,
            },
        ];
    }

    installed(id: string): boolean {
        return this.installedModel && id === VOICE_DEFAULT_MODEL_ID;
    }

    modelDir(_id: string): string {
        return '/tmp/mazi-voice-fake-model';
    }

    startDownload(_id: string): { jobId: string } {
        const jobId = 'job-1';
        this.downloads.set(jobId, { status: 'done', progress: 1 });
        return { jobId };
    }

    downloadStatus(jobId: string) {
        return this.downloads.get(jobId);
    }

    autoInstallStatus(): VoiceInstallStatus | undefined {
        return this.installStatus;
    }

    remove(): void {
        this.installedModel = false;
    }
}

describe('voice API plugin', () => {
    let app: FastifyInstance;
    let engine: FakeEngine;
    let models: FakeModels;

    beforeAll(async () => {
        app = Fastify({ logger: false });
        engine = new FakeEngine();
        models = new FakeModels();
        await app.register(voicePlugin, { engine, models, limits: { maxSessions: 8 } });
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    it('GET /api/voice/capabilities 返回本机引擎与模型', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/voice/capabilities' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.engines.local.available).toBe(true);
        expect(body.models[0].id).toBe(VOICE_DEFAULT_MODEL_ID);
        expect(body.limits.maxChunkBytes).toBe(VOICE_DEFAULT_LIMITS.maxChunkBytes);
        expect(body.security.loopbackOnly).toBe(true);
        expect(body.install).toBeUndefined();
    });

    it('capabilities 暴露服务启动自动安装进度', async () => {
        models.installStatus = {
            modelId: VOICE_DEFAULT_MODEL_ID,
            status: 'running',
            progress: 0.42,
        };
        const res = await app.inject({ method: 'GET', url: '/api/voice/capabilities' });
        expect(res.statusCode).toBe(200);
        expect(res.json().install).toMatchObject({
            modelId: VOICE_DEFAULT_MODEL_ID,
            status: 'running',
            progress: 0.42,
        });
        models.installStatus = undefined;
    });

    it('创建 session 并分块识别，end 返回 final', async () => {
        const created = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/sessions',
            payload: { modelId: VOICE_DEFAULT_MODEL_ID, language: 'zh-CN' },
        });
        expect(created.statusCode).toBe(200);
        const session = created.json();
        expect(typeof session.token).toBe('string');
        expect(engine.opened).toBe(1);

        const pcm = Buffer.from(new Int16Array([100, 200]).buffer).toString('base64');
        const partial = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/chunk',
            payload: { ...session, seq: 0, pcmBase64: pcm },
        });
        expect(partial.statusCode).toBe(200);
        expect(partial.json().type).toBe('partial');

        const final = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/chunk',
            payload: { ...session, seq: 1, pcmBase64: '', end: true },
        });
        expect(final.statusCode).toBe(200);
        expect(final.json()).toMatchObject({ type: 'final', text: '你好 mazi', done: true });
        expect(engine.closed).toBeGreaterThanOrEqual(1);
    });

    it('重复 seq 幂等，不重复喂音频', async () => {
        const created = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/sessions',
            payload: {},
        });
        const session = created.json();
        const pcm = Buffer.from(new Int16Array([1, 2]).buffer).toString('base64');
        await app.inject({
            method: 'POST',
            url: '/api/voice/asr/chunk',
            payload: { ...session, seq: 0, pcmBase64: pcm },
        });
        const replay = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/chunk',
            payload: { ...session, seq: 0, pcmBase64: pcm },
        });
        expect(replay.statusCode).toBe(200);
        expect(replay.json().type).toBe('partial');
    });

    it('错误 token → 401，Origin 不符 → 403', async () => {
        const created = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/sessions',
            payload: {},
        });
        const session = created.json();
        const bad = await app.inject({
            method: 'POST',
            url: '/api/voice/asr/chunk',
            payload: { ...session, token: 'bad', seq: 0, pcmBase64: '' },
        });
        expect(bad.statusCode).toBe(401);

        const denied = await app.inject({
            method: 'GET',
            url: '/api/voice/capabilities',
            headers: { origin: 'https://evil.example' },
        });
        expect(denied.statusCode).toBe(403);
    });

    it('非 loopback 请求被拒绝', async () => {
        const blocked = await app.inject({
            method: 'GET',
            url: '/api/voice/capabilities',
            remoteAddress: '192.168.1.5',
        });
        expect(blocked.statusCode).toBe(403);
    });

    it('模型下载与状态接口', async () => {
        const started = await app.inject({
            method: 'POST',
            url: `/api/voice/models/${VOICE_DEFAULT_MODEL_ID}/download`,
        });
        expect(started.statusCode).toBe(200);
        expect(started.json().jobId).toBe('job-1');
        const status = await app.inject({
            method: 'GET',
            url: '/api/voice/models/downloads/job-1',
        });
        expect(status.statusCode).toBe(200);
        expect(status.json()).toMatchObject({ status: 'done', progress: 1 });
    });

    it('模型缺失时 capabilities 降级', async () => {
        models.installedModel = false;
        const res = await app.inject({ method: 'GET', url: '/api/voice/capabilities' });
        expect(res.json().engines.local.available).toBe(false);
        expect(res.json().engines.local.reason).toBe('model_missing');
        models.installedModel = true;
    });
});
