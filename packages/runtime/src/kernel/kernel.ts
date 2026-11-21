/**
 * RuntimeKernel —— 最小装配容器（docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §5）。
 *
 * 只解决三件事：服务注册、依赖顺序、可逆注册。刻意保持同步：
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
    private readonly effects: Array<{ id: number; dispose: () => void; revoked: boolean }> = [];
    private readonly onError: (error: unknown, context: string) => void;

    private started = false;
    private disposed = false;
    private nextEffectId = 1;

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

    /**
     * 注册可逆副作用（prompt 片段、工具注册、监听器…）。
     * 返回撤销函数：调用即回收，重复调用幂等。
     */
    effect(dispose: () => void): () => void {
        if (this.disposed) throw new Error('kernel 已释放，不能再注册 effect');
        const entry = { id: this.nextEffectId++, dispose, revoked: false };
        this.effects.push(entry);
        return () => {
            if (entry.revoked) return;
            entry.revoked = true;
            try {
                entry.dispose();
            } catch (error) {
                this.onError(error, `effect#${entry.id} revoke`);
            }
        };
    }

    /** 逆序回收：effects → 服务 dispose；单个失败隔离，继续处理其余。 */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const entry of this.effects.splice(0).reverse()) {
            if (entry.revoked) continue;
            try {
                entry.dispose();
            } catch (error) {
                this.onError(error, `effect#${entry.id} dispose`);
            }
        }
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
