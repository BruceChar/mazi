import { describe, expect, it } from 'vitest';
import { RuntimeKernel } from '../src/kernel/index.js';

describe('RuntimeKernel（§5 装配容器）', () => {
    it('按依赖拓扑顺序实例化，并按名字取服务', () => {
        const order: string[] = [];
        const kernel = new RuntimeKernel();
        kernel.provide({
            name: 'tools',
            create: () => {
                order.push('tools');
                return { tools: true };
            },
        });
        kernel.provide({
            name: 'hooks',
            requires: ['eventBus'],
            create: () => {
                order.push('hooks');
                return { hooks: true };
            },
        });
        kernel.provide({
            name: 'eventBus',
            create: () => {
                order.push('eventBus');
                return { bus: true };
            },
        });
        kernel.start();
        // 注册顺序决定遍历顺序；依赖保证 eventBus 先于 hooks。
        expect(order).toEqual(['tools', 'eventBus', 'hooks']);
        expect(kernel.stateOf('hooks')).toBe('active');
        expect(kernel.get<{ hooks: boolean }>('hooks')).toEqual({ hooks: true });
        expect(kernel.get<{ bus: boolean }>('eventBus')).toEqual({ bus: true });
    });

    it('缺失依赖 fail-fast，并给出依赖链', () => {
        const kernel = new RuntimeKernel();
        kernel.provide({ name: 'hooks', requires: ['eventBus'], create: () => ({}) });
        expect(() => kernel.start()).toThrow(/依赖缺失.*eventBus/);
        expect(kernel.stateOf('hooks')).toBe('pending');
    });

    it('环依赖 fail-fast', () => {
        const kernel = new RuntimeKernel();
        kernel.provide({ name: 'a', requires: ['b'], create: () => ({}) });
        kernel.provide({ name: 'b', requires: ['a'], create: () => ({}) });
        expect(() => kernel.start()).toThrow(/成环/);
    });

    it('重复注册、未就绪与未知服务都有明确错误', () => {
        const kernel = new RuntimeKernel();
        kernel.provide({ name: 'a', create: () => 1 });
        expect(() => kernel.provide({ name: 'a', create: () => 2 })).toThrow(/重复注册/);
        expect(() => kernel.get('a')).toThrow(/未就绪/);
        expect(() => kernel.get('nope')).toThrow(/未知服务/);
        kernel.start();
        expect(() => kernel.get('a')).not.toThrow();
    });

    it('dispose 逆序释放服务，单个失败隔离并继续', () => {
        const order: string[] = [];
        const errors: string[] = [];
        const kernel = new RuntimeKernel({ onError: (error, context) => errors.push(`${context}:${String(error)}`) });
        kernel.provide({
            name: 'a',
            create: () => 1,
            dispose: () => {
                order.push('a');
                throw new Error('a failed');
            },
        });
        kernel.provide({
            name: 'b',
            requires: ['a'],
            create: () => 2,
            dispose: () => order.push('b'),
        });
        kernel.start();
        kernel.dispose();
        expect(order).toEqual(['b', 'a']);
        expect(errors[0]).toContain('a failed');
        expect(kernel.stateOf('b')).toBe('disposed');
        expect(() => kernel.get('a')).toThrow(/disposed/);
    });
});
