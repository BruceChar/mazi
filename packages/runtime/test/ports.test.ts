import { describe, expect, it } from 'vitest';
import { RuntimePorts } from '../src/kernel/ports.js';

describe('RuntimePorts', () => {
    it('登记后可读，撤销只移除自己登记的那一版', () => {
        const ports = new RuntimePorts();
        const undoFirst = ports.set('skillProvider', { id: 'first' });
        ports.set('skillProvider', { id: 'second' });
        expect(ports.get<{ id: string }>('skillProvider')?.id).toBe('second');
        undoFirst();
        expect(ports.get<{ id: string }>('skillProvider')?.id).toBe('second');
        expect(ports.names()).toEqual(['skillProvider']);
    });

    it('未登记与清空后都返回 undefined', () => {
        const ports = new RuntimePorts();
        expect(ports.has('catalog')).toBe(false);
        const undo = ports.set('catalog', {});
        undo();
        expect(ports.get('catalog')).toBeUndefined();
        expect(ports.names()).toEqual([]);
    });
});
