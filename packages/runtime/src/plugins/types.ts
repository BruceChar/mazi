import type { HookRegistration, Unsubscribe } from '@mazi/core';
import type { DefaultEventBus } from '../events/event-bus.js';
import type { RuntimeKernel, ServiceDefinition } from '../kernel/index.js';
import type { RuntimePortName, RuntimePorts } from '../kernel/ports.js';

/**
 * 插件清单：声明式描述插件提供什么、依赖什么、挂哪些钩子与接入点。
 *
 * manifest 只描述形状；实际副作用全部发生在 install() 里，宿主据此
 * 一次性完成注册并在 uninstall() 时逆序撤销。
 */
export interface PluginManifest {
    id: string;
    version: string;
    description?: string;
    /** 需要已就绪的 kernel 服务（缺失时安装 fail-fast）。 */
    requires?: readonly string[];
    /** 插件提供的 kernel 服务定义。 */
    provides?: readonly ServiceDefinition<unknown>[];
    /** 挂载的钩子（注册返回值用于卸载）。 */
    hooks?: readonly HookRegistration[];
    /** 登记的运行期接入点。 */
    ports?: readonly { name: RuntimePortName; value: unknown }[];
}

export interface PluginContext {
    kernel: RuntimeKernel;
    hooks: { register(registration: HookRegistration): Unsubscribe };
    ports: RuntimePorts;
    eventBus: DefaultEventBus;
}

export interface RuntimePlugin {
    manifest: PluginManifest;
    /** 安装（同步或异步）；抛错则本次安装整体回滚。 */
    install(context: PluginContext): void | Promise<void>;
    /** 额外清理（内核服务/钩子/接入点由宿主自动撤销）。 */
    uninstall?(): void | Promise<void>;
}
