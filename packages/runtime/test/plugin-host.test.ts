import { describe, expect, it } from 'vitest';
import type { HookRegistration } from '@mazi/core';
import { DefaultEventBus } from '../src/events/event-bus.js';
import { HookRunner } from '../src/hooks/runner.js';
import { RuntimeKernel } from '../src/kernel/index.js';
import { RuntimePorts } from '../src/kernel/ports.js';
import { PluginHost } from '../src/plugins/host.js';
import type { RuntimePlugin } from '../src/plugins/types.js';

function buildHost(): { host: PluginHost; kernel: RuntimeKernel; ports: RuntimePorts } {
    const kernel = new RuntimeKernel({ onError: () => {} });
    kernel.provide({ name: 'eventBus', create: () => new DefaultEventBus() });
    kernel.provide({ name: 'hooks', requires: ['eventBus'], create: () => new HookRunner({ emit: () => {} }) });
    kernel.start();
    const hooks = kernel.get<HookRunner>('hooks');
    const ports = new RuntimePorts();
    const host = new PluginHost({
        kernel,
        hooks,
        ports,
        eventBus: kernel.get<DefaultEventBus>('eventBus'),
    });
    return { host, kernel, ports };
}

const turnStartHook: HookRegistration = {
    id: 'probe.turn',
    point: 'turn.start',
    mode: 'observe',
    handler: () => undefined,
};

function plugin(overrides: Partial<RuntimePlugin['manifest']> = {}): RuntimePlugin {
    return {
        manifest: {
            id: 'probe',
            version: '0.1.0',
            requires: ['eventBus'],
            provides: [{ name: 'probeService', create: () => ({ ok: true }) }],
            hooks: [turnStartHook],
            ports: [{ name: 'skillProvider', value: { id: 'probe-skill' } }],
            ...overrides,
        },
        install: () => undefined,
    };
}

describe('PluginHost', () => {
    it('安装即注册服务/钩子/接入点，卸载后全部撤销', async () => {
        const { host, kernel, ports } = buildHost();
        await host.install(plugin());
        expect(kernel.stateOf('probeService')).toBe('active');
        expect(ports.get<{ id: string }>('skillProvider')?.id).toBe('probe-skill');
        expect(host.installedIds()).toEqual(['probe']);

        expect(await host.uninstall('probe')).toBe(true);
        expect(kernel.stateOf('probeService')).toBeUndefined();
        expect(ports.get('skillProvider')).toBeUndefined();
        expect(host.installedIds()).toEqual([]);
    });

    it('重复安装与缺失依赖都 fail-fast', async () => {
        const { host } = buildHost();
        await host.install(plugin());
        await expect(host.install(plugin())).rejects.toThrow(/重复安装/);
        await expect(
            host.install(plugin({ id: 'missing', requires: ['nope'], provides: [], hooks: [], ports: [] })),
        ).rejects.toThrow(/依赖未就绪/);
    });

    it('安装中途抛错时回滚已登记的条目', async () => {
        const { host, kernel, ports } = buildHost();
        const broken = plugin({ id: 'broken' });
        broken.install = () => {
            throw new Error('boom');
        };
        await expect(host.install(broken)).rejects.toThrow('boom');
        expect(kernel.stateOf('probeService')).toBeUndefined();
        expect(ports.get('skillProvider')).toBeUndefined();
        expect(host.installedIds()).toEqual([]);
    });
});
