/**
 * 冷加载槽：把资源构造推迟到首次使用。
 *
 * 构造与装配阶段只建槽（纯对象，无 IO）；消费方拿到的是代理视图，任何方法调用
 * 才触发真正的 `open()`，且单飞只开一次。`closeIfOpen()` 幂等，未打开的槽不产生
 * 任何副作用——这是「冷构造不碰 IO」的实现基础。
 */
export class LazySlot<T extends object> {
    private instance: T | undefined;
    private cachedView: T | undefined;

    constructor(private readonly open: () => T) {}

    /** 触发打开并返回真实实例（已打开则直接返回）。 */
    get(): T {
        this.instance ??= this.open();
        return this.instance;
    }

    /** 只读探测：不触发打开。 */
    peek(): T | undefined {
        return this.instance;
    }

    isOpen(): boolean {
        return this.instance !== undefined;
    }

    /**
     * 代理视图：属性访问转发到真实实例，方法自动绑定，避免 `this` 丢失。
     *
     * 视图身份稳定（ctx 上的字段就是这个代理），因此可以安全地传给协作者；
     * 关闭后再调用会按需重建，属于使用方越界，不在契约内。
     */
    view(): T {
        if (this.cachedView !== undefined) return this.cachedView;
        const slot = this;
        this.cachedView = new Proxy({} as T, {
            get(_target, prop) {
                const instance = slot.get() as Record<PropertyKey, unknown>;
                const value = instance[prop];
                return typeof value === 'function' ? value.bind(instance) : value;
            },
            has(_target, prop) {
                return prop in (slot.get() as object);
            },
            getPrototypeOf() {
                return Object.getPrototypeOf(slot.get() as object);
            },
        });
        return this.cachedView;
    }

    /** 若已打开则释放；未打开时为空操作。 */
    closeIfOpen(): void {
        const instance = this.instance;
        this.instance = undefined;
        const close = (instance as { close?: () => void } | undefined)?.close;
        if (typeof close === 'function') close.call(instance);
    }
}
