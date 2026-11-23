import type { Unsubscribe } from '@mazi/core';
import type { DefaultEventBus } from '../events/event-bus.js';
import type { RuntimeKernel } from '../kernel/index.js';
import type { RuntimePorts } from '../kernel/ports.js';
import type { PluginContext, RuntimePlugin } from './types.js';

export interface PluginHostDeps {
    kernel: RuntimeKernel;
    hooks: PluginContext['hooks'];
    ports: RuntimePorts;
    eventBus: DefaultEventBus;
}

interface InstalledPlugin {
    plugin: RuntimePlugin;
    undo: Unsubscribe[];
    services: string[];
}

/**
 * PluginHost —— 插件装入/卸下的唯一入口。
 *
 * 安装前校验依赖服务已就绪；安装中登记的 kernel 服务、钩子、接入点
 * 全部记账，卸载时逆序撤销。安装失败即回滚，不留半装状态。
 */
export class PluginHost {
    private readonly installed = new Map<string, InstalledPlugin>();

    constructor(private readonly deps: PluginHostDeps) {}

    installedIds(): string[] {
        return [...this.installed.keys()];
    }

    async install(plugin: RuntimePlugin): Promise<Unsubscribe> {
        const manifest = plugin.manifest;
        if (this.installed.has(manifest.id)) {
            throw new Error(`插件重复安装：${manifest.id}`);
        }
        for (const dependency of manifest.requires ?? []) {
            if (this.deps.kernel.stateOf(dependency) !== 'active') {
                throw new Error(`插件依赖未就绪：${manifest.id} → ${dependency}`);
            }
        }
        const record: InstalledPlugin = { plugin, undo: [], services: [] };
        try {
            for (const definition of manifest.provides ?? []) {
                this.deps.kernel.provide(definition);
                record.services.push(definition.name);
            }
            for (const registration of manifest.hooks ?? []) {
                record.undo.push(this.deps.hooks.register(registration));
            }
            for (const port of manifest.ports ?? []) {
                record.undo.push(this.deps.ports.set(port.name, port.value));
            }
            await plugin.install({
                kernel: this.deps.kernel,
                hooks: this.deps.hooks,
                ports: this.deps.ports,
                eventBus: this.deps.eventBus,
            });
        } catch (error) {
            await this.rollback(record);
            throw error;
        }
        this.installed.set(manifest.id, record);
        return () => {
            void this.uninstall(manifest.id);
        };
    }

    async uninstall(id: string): Promise<boolean> {
        const record = this.installed.get(id);
        if (record === undefined) return false;
        this.installed.delete(id);
        await this.rollback(record);
        return true;
    }

    async uninstallAll(): Promise<void> {
        for (const id of [...this.installed.keys()].reverse()) {
            await this.uninstall(id);
        }
    }

    private async rollback(record: InstalledPlugin): Promise<void> {
        try {
            await record.plugin.uninstall?.();
        } finally {
            for (const undo of record.undo.splice(0).reverse()) {
                try {
                    undo();
                } catch {
                    // 单个撤销失败不阻断其余清理
                }
            }
            for (const name of record.services.splice(0).reverse()) {
                try {
                    this.deps.kernel.unregister(name);
                } catch {
                    // 仍被依赖的服务由 kernel 拒绝撤销；不影响其余清理
                }
            }
        }
    }
}
