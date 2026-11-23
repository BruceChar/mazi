/**
 * RuntimeKernel —— 最小装配容器（docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §5）。
 *
 * 只解决三件事：服务注册、依赖顺序、生命周期释放。刻意保持同步：
 * 当前所有服务都是构造期同步可得的；需要异步初始化时再引入 startAsync，
 * 避免把"装配"变成第二个隐式状态机。
 */

export type KernelServiceState = 'pending' | 'loading' | 'active' | 'disposed';

export interface ServiceDefinition<T> {
    /** 稳定服务名（消费方按名字取用，不 import 具体实现）。 */
    name: string;
    /** 依赖的服务名；start() 时按拓扑顺序实例化。 */
    requires?: readonly string[];
    create: () => T;
    /** 可选释放逻辑；dispose() 时逆序调用。 */
    dispose?: (value: T) => void;
}

export interface RuntimeKernelOptions {
    /** 装配/释放错误出口（默认写 stderr）；单个失败不影响其余服务。 */
    onError?: (error: unknown, context: string) => void;
}

export class RuntimeKernel {
    private readonly definitions = new Map<string, ServiceDefinition<unknown>>();
    private readonly instances = new Map<string, unknown>();
    private readonly states = new Map<string, KernelServiceState>();
    private readonly instantiationOrder: string[] = [];
    private readonly onError: (error: unknown, context: string) => void;

    private started = false;
    private disposed = false;

    constructor(options: RuntimeKernelOptions = {}) {
        this.onError =
            options.onError ??
            ((error, context) => {
                process.stderr.write(`kernel ${context} error: ${String(error)}\n`);
            });
    }

    /**
     * 注册服务定义（不实例化）。重复 name 直接拒绝：服务名是公开契约，
     * 静默覆盖会让依赖方拿到意料之外的实现。
     */
    provide<T>(definition: ServiceDefinition<T>): void {
        if (this.disposed) throw new Error(`kernel 已释放，不能再注册服务：${definition.name}`);
        if (this.definitions.has(definition.name)) {
            throw new Error(`服务重复注册：${definition.name}`);
        }
        this.definitions.set(definition.name, definition as ServiceDefinition<unknown>);
        this.states.set(definition.name, 'pending');
        // 运行期装入（插件）时立即可用；失败则回滚注册，不留半装条目。
        if (this.started) {
            try {
                this.instantiate(definition.name, []);
            } catch (error) {
                this.definitions.delete(definition.name);
                this.states.delete(definition.name);
                throw error;
            }
        }
    }

    /**
     * 撤销一个服务（插件卸载用）。仍有其他服务依赖它时拒绝；
     * 释放逻辑照常执行，之后该名字回到未知状态。
     */
    unregister(name: string): void {
        if (this.disposed) throw new Error(`kernel 已释放，不能再撤销服务：${name}`);
        const dependents = [...this.definitions.values()].filter(
            (definition) => definition.name !== name && (definition.requires ?? []).includes(name),
        );
        if (dependents.length > 0) {
            throw new Error(
                `服务仍被依赖，不能撤销：${name} ← ${dependents.map((item) => item.name).join(', ')}`,
            );
        }
        const definition = this.definitions.get(name);
        if (definition === undefined) return;
        const value = this.instances.get(name);
        if (definition.dispose !== undefined && value !== undefined) {
            try {
                definition.dispose(value);
            } catch (error) {
                this.onError(error, `service ${name} dispose`);
            }
        }
        this.definitions.delete(name);
        this.instances.delete(name);
        this.states.delete(name);
        const index = this.instantiationOrder.indexOf(name);
        if (index >= 0) this.instantiationOrder.splice(index, 1);
    }

    /** 按依赖拓扑实例化全部服务；缺失依赖或环依赖 fail-fast。 */
    start(): void {
        if (this.started) return;
        this.started = true;
        for (const name of this.definitions.keys()) {
            this.instantiate(name, []);
        }
    }

    /** 取已就绪服务；未 start / 未 active / 已释放都有明确错误。 */
    get<T>(name: string): T {
        const state = this.states.get(name);
        if (state === undefined) throw new Error(`未知服务：${name}`);
        if (state !== 'active') throw new Error(`服务未就绪：${name}（state=${state}）`);
        return this.instances.get(name) as T;
    }

    stateOf(name: string): KernelServiceState | undefined {
        return this.states.get(name);
    }

    list(): ReadonlyArray<{ name: string; state: KernelServiceState }> {
        return [...this.states.entries()].map(([name, state]) => ({ name, state }));
    }

    /** 逆序释放服务；单个失败隔离，继续处理其余。 */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const name of this.instantiationOrder.slice().reverse()) {
            const definition = this.definitions.get(name);
            const value = this.instances.get(name);
            if (definition?.dispose !== undefined && value !== undefined) {
                try {
                    definition.dispose(value);
                } catch (error) {
                    this.onError(error, `service ${name} dispose`);
                }
            }
            this.states.set(name, 'disposed');
        }
        this.instances.clear();
    }

    private instantiate(name: string, stack: readonly string[]): void {
        const state = this.states.get(name);
        if (state === 'active' || state === 'disposed') return;
        if (state === 'loading') {
            throw new Error(`服务依赖成环：${[...stack, name].join(' → ')}`);
        }
        const definition = this.definitions.get(name);
        if (definition === undefined) {
            throw new Error(`服务依赖缺失：${[...stack, name].join(' → ')}（未注册 ${name}）`);
        }
        this.states.set(name, 'loading');
        try {
            for (const dependency of definition.requires ?? []) {
                this.instantiate(dependency, [...stack, name]);
            }
            const value = definition.create();
            this.instances.set(name, value);
            this.states.set(name, 'active');
            this.instantiationOrder.push(name);
        } catch (error) {
            this.states.set(name, 'pending');
            throw error instanceof Error
                ? error
                : new Error(`服务 ${name} 初始化失败：${String(error)}`);
        }
    }
}
